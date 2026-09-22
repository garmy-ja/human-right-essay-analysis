import sqlite3
import json
import pandas as pd
import numpy as np
import umap
import hdbscan
import plotly.express as px

# 1. SQLiteデータベースからのデータ読み込み
DB_PATH = 'essays.db'

def load_data():
    print("Step 1: SQLiteデータベースからデータを読み込んでいます...")
    conn = sqlite3.connect(DB_PATH)
    query = "SELECT id, year, grade, prefecture, title, body, body_embedding, title_embedding FROM essays"
    df = pd.read_sql_query(query, conn)
    conn.close()
    return df

def generate_scatter_plot(dataframe, color_col, title_text, output_html):
    """
    Plotlyの散布図と、その下にソート可能なデータテーブルを含むHTMLファイルを生成する。
    """
    hover_cols = ['id', 'year', 'title', color_col]

    fig = px.scatter(
        dataframe,
        x='x',
        y='y',
        color=color_col,
        hover_data=hover_cols,
        title=title_text,
        template='plotly_white',
        width=1000,
        height=700
    )
    fig.update_traces(marker=dict(size=8, opacity=0.8))

    # Plotly図をHTML文字列として取得
    plot_html = fig.to_html(full_html=False, include_plotlyjs='cdn')

    table_df = dataframe[['id', 'year', 'title', color_col]].copy()
    table_df.columns = ['ID', 'Year', 'Title', 'Category']
    table_html_rows = "".join([
        f"<tr><td>{row['ID']}</td><td>{row['Year']}</td><td>{row['Title']}</td><td>{row['Category']}</td></tr>"
        for _, row in table_df.iterrows()
    ])

    # フルHTMLの構築
    full_html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>{title_text}</title>
        <style>
            body {{ font-family: sans-serif; margin: 20px; background-color: #f9f9f9; }}
            .container {{ max-width: 1100px; margin: auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }}
            h1 {{ text-align: center; color: #333; }}
            table {{ width: 100%; border-collapse: collapse; margin-top: 30px; font-size: 14px; }}
            th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
            th {{ background-color: #f2f2f2; cursor: pointer; position: relative; }}
            th:hover {{ background-color: #e2e2e2; }}
            th::after {{ content: ' ↕'; font-size: 10px; color: #999; }}
            tr:nth-child(even) {{ background-color: #f9f9f9; }}
            tr:hover {{ background-color: #f1f1f1; }}
        </style>
        <script>
            function sortTable(n) {{
                var table, rows, switching, i, x, y, shouldSwitch, dir, switchcount = 0;
                table = document.getElementById("dataTable");
                switching = true;
                dir = "asc";
                while (switching) {{
                    switching = false;
                    rows = table.rows;
                    for (i = 1; i < (rows.length - 0); i++) {{
                        shouldSwitch = false;
                        x = rows[i].getElementsByTagName("TD")[n];
                        y = rows[i + 1].getElementsByTagName("TD")[n];
                        let valX = x.innerHTML.toLowerCase();
                        let valY = y.innerHTML.toLowerCase();
                        if (!isNaN(parseFloat(valX)) && !isNaN(parseFloat(valY))) {{
                            valX = parseFloat(valX);
                            valY = parseFloat(valY);
                        }}
                        if (dir == "asc") {{
                            if (valX > valY) {{ shouldSwitch = true; break; }}
                        }} else if (dir == "desc") {{
                            if (valX < valY) {{ shouldSwitch = true; break; }}
                        }}
                    }}
                    if (shouldSwitch) {{
                        rows[i].parentNode.insertBefore(rows[i + 1], rows[i]);
                        switching = true;
                        switchcount ++;
                    }} else {{
                        if (switchcount == 0 && dir == "asc") {{
                            dir = "desc";
                            switching = true;
                        }}
                    }}
                }}
            }}
        </script>
    </head>
    <body>
        <div class="container">
            <h1>{title_text}</h1>
            <div>{plot_html}</div>
            <hr>
            <h2>データ一覧</h2>
            <table id="dataTable">
                <thead>
                    <tr>
                        <th onclick="sortTable(0)">ID</th>
                        <th onclick="sortTable(1)">Year</th>
                        <th onclick="sortTable(2)">Title</th>
                        <th onclick="sortTable(3)">Category</th>
                    </tr>
                </thead>
                <tbody>
                    {table_html_rows}
                </tbody>
            </table>
        </div>
    </body>
    </html>
    """
    with open(output_html, "w", encoding="utf-8") as f:
        f.write(full_html)
    print(f"保存完了: {output_html}")

def analyze_and_plot(df_original, embedding_col, prefix):
    print(f"\n--- {prefix} embedding による分析を開始します ---")

    # 埋め込みベクトルがNULLの行を除外
    df = df_original.dropna(subset=[embedding_col]).copy()
    initial_count = len(df_original)
    dropped_count = initial_count - len(df)
    if dropped_count > 0:
        print(f"警告: {embedding_col} がNULLのデータを {dropped_count} 件除外しました。")

    # ベクトルをnumpy配列に変換
    print(f"Step 2: {embedding_col} をnumpy配列に変換しています...")
    embeddings = np.array([json.loads(vec) for vec in df[embedding_col]])

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

            # ターゲット範囲内に入った場合、最も多いものを優先的に選択
            if target_min <= unique_clusters <= target_max:
                if unique_clusters > best_cluster_count:
                    best_cluster_count = unique_clusters
                    best_params = (mcs, ms)

            # ターゲット範囲外だが、今のところ最高の結果である場合（暫定的な保持）
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

    print(f"Step 5: 可視化用の次元削減 (UMAP 2D) を実行中...")
    umap_reducer_2d = umap.UMAP(
        n_components=2,
        n_neighbors=15,
        min_dist=0.1,
        metric='cosine',
        random_state=42
    )
    embeddings_2d = umap_reducer_2d.fit_transform(embeddings)
    df['x'] = embeddings_2d[:, 0]
    df['y'] = embeddings_2d[:, 1]

    print(f"Step 6: Plotlyによる可視化ファイルを生成しています...")

    # A. クラスタ別プロット
    generate_scatter_plot(
        df, 'cluster',
        f'{prefix} 埋め込みベクトルのクラスタ分析 (HDBSCAN)',
        f'plot_{prefix}_clusters.html'
    )

    # B. フィールド別プロット (year, grade, prefecture)
    fields = {
        'year': '年度',
        'grade': '学年',
        'prefecture': '学校所在地'
    }
    for field, label in fields.items():
        color_col_name = f'{field}_str'
        df[color_col_name] = df[field].astype(str)
        generate_scatter_plot(
            df, color_col_name,
            f'{prefix} 埋め込みベクトル {label}別分布プロット',
            f'plot_{prefix}_by_{field}.html'
        )

# メイン処理
if __name__ == "__main__":
    df_all = load_data()

    # Body Embedding の分析
    analyze_and_plot(df_all, 'body_embedding', 'body')

    # Title Embedding の分析
    analyze_and_plot(df_all, 'title_embedding', 'title')
    print("\nすべての分析と可視化が完了しました。")
