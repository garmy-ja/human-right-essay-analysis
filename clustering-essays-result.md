# 作文埋め込みベクトル・クラスタリング分析ツールの改修結果

本ドキュメントは、`analyze-essays.py` のデバッグおよび機能拡張の作業内容と結果をまとめたものです。

## 1. 作業目的
作文の埋め込みベクトル（BodyおよびTitle）を用いて、UMAPによる次元削減とHDBSCANによるクラスタリングを行い、その結果をインタラクティブな散布図として可視化する。また、分析結果を詳細に確認するためのUI改善と、クラスタ数の最適化を行う。

## 2. 実施内容

### 2.1 デバッグおよび基礎改善
- **進捗可視化**: 処理の各ステップ（データ読み込み $\rightarrow$ ベクトル変換 $\rightarrow$ 次元削減 $\rightarrow$ クラスタリング $\rightarrow$ 可視化）にログ出力（`print` 文）を追加し、実行状況を把握可能にした。
- **NULLデータ対策**: `body_embedding` が `NULL` (NaN) のデータが存在することで `json.loads` で `TypeError` が発生していた問題を、読み込み直後の `dropna` 処理により修正した。

### 2.2 分析対象と出力の拡張
- **分析軸の追加**: 
    - `body_embedding` に加え、`title_embedding` を用いた同様の分析フローを実装。
    - プロットの色分け項目に `prefecture` (学校所在地) を追加。
- **出力ファイル名の体系化**: 
    - `plot_{embedding_type}_{category}.html` の形式に変更（例: `plot_title_by_prefecture.html`）。
- **ホバーデータの最適化**: 
    - 視認性向上のため、ホバー表示を `id`, `year`, `title`, および `色分け項目` のみに限定した。

### 2.3 UI/UX の向上
- **データ一覧テーブルの追加**: 
    - 各HTMLファイルのグラフ下部に、プロットデータの一覧表を実装。
    - **ソート機能**: JavaScriptを組み込み、`ID`, `Year`, `Title`, `Category` の各列をクリックすることで昇順・降順にソート可能とした。

### 2.4 クラスタリング精度の最適化
- **クラスタ数自動調整ロジックの実装**:
    - 単純な閾値設定ではクラスタ数が極端に少なくなる（2個など）または多くなる傾向があったため、**グリッドサーチによるパラメータ最適化**を導入。
    - `min_cluster_size` と `min_samples` の組み合わせを試行し、クラスタ数が **10〜15個** の範囲に収まり、かつ最も多く分かれる設定を自動的に選択するように変更した。

## 3. 最終的な実行結果

### 処理フロー
1. SQLiteからデータ読み込み $\rightarrow$ NULL除外
2. `body_embedding` 分析 $\rightarrow$ パラメータ最適化 $\rightarrow$ 可視化ファイル生成
3. `title_embedding` 分析 $\rightarrow$ パラメータ最適化 $\rightarrow$ 可視化ファイル生成

### 生成ファイル
以下の形式で計8ファイル（＋α）が生成される。
- **クラスタ分析**: `plot_body_clusters.html`, `plot_title_clusters.html`
- **属性別分布**: 
    - 年度別: `plot_body_by_year.html`, `plot_title_by_year.html`
    - 学年別: `plot_body_by_grade.html`, `plot_title_by_grade.html`
    - 所在地別: `plot_body_by_prefecture.html`, `plot_title_by_prefecture.html`

### クラスタリング結果 (最終実行時)
- **Body Embedding**: クラスタ数 **15** (`min_cluster_size: 5, min_samples: 1`)
- **Title Embedding**: クラスタ数 **15** (`min_cluster_size: 3, min_samples: 4`)

## 4. 結論
プログラムは `venv` 環境においてエラーなく動作し、目標としていた「10〜15個程度の適切なクラスタ分割」と「詳細データのソート可能な一覧表示」を実現した。

※人間による加筆：
　処理に要したリクエスト回数は26回。
