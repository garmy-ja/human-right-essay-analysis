import sqlite3
import json
import pandas as pd
import numpy as np
import umap
import hdbscan

# 1. SQLiteデータベースからのデータ読み込み
DB_PATH = 'essays.db'

def load_data():
    print("Step 1: SQLiteデータベースからデータを読み込んでいます...")
    conn = sqlite3.connect(DB_PATH)
    query = "SELECT id, body_embedding FROM essays"
    df = pd.read_sql_query(query, conn)
    conn.close()
    return df

def save_clusters(df):
    print("Step 6: クラスタリング結果をデータベースに保存しています...")
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # テーブルの作成 (id, cluster)
    cursor.execute("DROP TABLE IF EXISTS essays_body_cluster")
    cursor.execute("CREATE TABLE essays_body_cluster (id INTEGER PRIMARY KEY, cluster TEXT)")

    # データの挿入
    data_to_insert = df[['id', 'cluster']].values.tolist()
    cursor.executemany("INSERT INTO essays_body_cluster (id, cluster) VALUES (?, ?)", data_to_insert)

    conn.commit()
    conn.close()
    print("保存完了: essays_body_cluster テーブル")

def analyze_and_cluster(df_original):
    print("\n--- body embedding によるクラスタリングを開始します ---")

    # 埋め込みベクトルがNULLの行を除外
    df = df_original.dropna(subset=['body_embedding']).copy()
    initial_count = len(df_original)
    dropped_count = initial_count - len(df)
    if dropped_count > 0:
        print(f"警告: body_embedding がNULLのデータを {dropped_count} 件除外しました。")

    # ベクトルをnumpy配列に変換
    print(f"Step 2: body_embedding をnumpy配列に変換しています...")
    embeddings = np.array([json.loads(vec) for vec in df['body_embedding']])

    # クラスタリングのための次元削減 (1024次元 -> 5次元)
    print(f"Step 3: クラスタリング用の次元削減 (UMAP 5D) を実行中...")
    umap_reducer_dense = umap.UMAP(
        n_components=5,
        n_neighbors=15,
        min_dist=0.0,
        metric='cosine',
        random_state=42
    )
    embeddings_5d = umap_reducer_dense.fit_transform(embeddings)

    # クラスタ数の最適化探索 (目標: 10個〜15個)
    print(f"Step 4: HDBSCANによるクラスタリングを実行中 (10-15個の範囲で最適化)...")

    best_params = (3, 2)
    best_cluster_count = 0
    target_min = 10
    target_max = 15

    for mcs in range(2, 11):
        for ms in range(1, 6):
            clusterer = hdbscan.HDBSCAN(
                min_cluster_size=mcs,
                min_samples=ms,
                metric='euclidean',
                cluster_selection_method='eom'
            )
            labels = clusterer.fit_predict(embeddings_5d)
            unique_clusters = len(set(labels)) - (1 if -1 in labels else 0)

            if target_min <= unique_clusters <= target_max:
                if unique_clusters > best_cluster_count:
                    best_cluster_count = unique_clusters
                    best_params = (mcs, ms)

            if best_cluster_count == 0 and unique_clusters < target_min:
                best_cluster_count = unique_clusters
                best_params = (mcs, ms)

    # 最終的に決定したパラメータで再実行
    final_mcs, final_ms = best_params
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=final_mcs,
        min_samples=final_ms,
        metric='euclidean',
        cluster_selection_method='eom'
    )
    df['cluster'] = clusterer.fit_predict(embeddings_5d).astype(str)

    actual_clusters = len(set(df['cluster'])) - (1 if '-1' in df['cluster'].values else 0)
    print(f"クラスタリング完了 (クラスタ数: {actual_clusters}, min_cluster_size: {final_mcs}, min_samples: {final_ms})")

    return df

if __name__ == "__main__":
    df_all = load_data()
    df_clustered = analyze_and_cluster(df_all)
    save_clusters(df_clustered)
    print("\nすべての処理が完了しました。")
