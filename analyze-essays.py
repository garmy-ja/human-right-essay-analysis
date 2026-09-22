import sqlite3
import json
import pandas as pd
import numpy as np
import umap
import hdbscan
import plotly.express as px

# 1. SQLiteデータベースからのデータ読み込み
print("Step 1: SQLiteデータベースからデータを読み込んでいます...")
DB_PATH = 'essays.db'  # SQLiteファイルのパスを指定してください

conn = sqlite3.connect(DB_PATH)
query = "SELECT id, year, grade, title, body, body_embedding FROM essays"
df = pd.read_sql_query(query, conn)
conn.close()

print(f"読み込み完了: {len(df)} 件")

# 2. JSON文字列として保存されている埋め込みベクトルをnumpy配列に変換
print("Step 2: 埋め込みベクトルをnumpy配列に変換しています...")
# (body_embedding を分析に使用)
embeddings = np.array([json.loads(vec) for vec in df['body_embedding']])
print("ベクトル変換完了")

# 3. クラスタリングのための次元削減 (1024次元 -> 5次元)
print("Step 3: クラスタリング用の次元削減 (UMAP 5D) を実行中...")
# ※ 高次元のままより、低次元に凝縮してからHDBSCANにかける方が精度が向上します
umap_reducer_dense = umap.UMAP(
    n_components=5,
    n_neighbors=15,
    min_dist=0.0,
    metric='cosine',
    random_state=42
)
embeddings_5d = umap_reducer_dense.fit_transform(embeddings)
print("次元削減 (5D) 完了")

# 4. HDBSCANによる自動クラスタリング
print("Step 4: HDBSCANによるクラスタリングを実行中...")
clusterer = hdbscan.HDBSCAN(
    min_cluster_size=5,       # 最小クラスタサイズの閾値（データ量に応じて調整）
    metric='euclidean',
    cluster_selection_method='eom'
)
df['cluster'] = clusterer.fit_predict(embeddings_5d).astype(str)
print("クラスタリング完了")

# 5. 可視化のための2次元削減 (1024次元 -> 2次元)
print("Step 5: 可視化用の次元削減 (UMAP 2D) を実行中...")
umap_reducer_2d = umap.UMAP(
    n_components=2,
    n_neighbors=15,
    min_dist=0.1,
    metric='cosine',
    random_state=42
)
embeddings_2d = umap_reducer_2d.fit_transform(embeddings)
print("次元削減 (2D) 完了")

df['x'] = embeddings_2d[:, 0]
df['y'] = embeddings_2d[:, 1]

# ツールチップ表示用に本文の冒頭100文字を抽出
df['body_snippet'] = df['body'].apply(lambda x: str(x)[:100] + '...' if pd.notnull(x) else '')

# 6. Plotlyによる可視化関数の定義
print("Step 6: Plotlyによる可視化ファイルを生成しています...")
def generate_scatter_plot(dataframe, color_col, title_text, output_html):
    fig = px.scatter(
        dataframe,
        x='x',
        y='y',
        color=color_col,
        hover_data=['id', 'title', 'year', 'grade', 'body_snippet'],
        title=title_text,
        template='plotly_white',
        width=1000,
        height=700
    )
    fig.update_traces(marker=dict(size=8, opacity=0.8))
    fig.write_html(output_html)
    print(f"保存完了: {output_html}")

# --- プロットの出力 ---
# A. 自動分類された「クラスタ別」プロット
generate_scatter_plot(df, 'cluster', '作文埋め込みベクトルのクラスタ分析 (HDBSCAN)', 'plot_clusters.html')

# B. 「年度別」分布プロット
df['year_str'] = df['year'].astype(str)
generate_scatter_plot(df, 'year_str', '年度別 作文分布プロット', 'plot_by_year.html')

# C. 「学年別」分布プロット
generate_scatter_plot(df, 'grade', '学年別 作文分布プロット', 'plot_by_grade.html')