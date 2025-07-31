# SNS Web 検索メッセージシステム

**Language / 言語 / 语言:** [English](./README.md) | [中文](./README.zh.md) | [日本語](./README.ja.md)

---

## プロジェクト概要

これは、ソーシャルメディアマーケティングと顧客開発に特化して設計されたインテリジェント管理プラットフォームです。このシステムは、企業やマーケティング担当者が主要なソーシャルプラットフォームで潜在的な顧客を効率的に発見し、自動化されたメッセージ送信機能を通じて精密なマーケティングを実現するのに役立ちます。

### コアビジネス価値

🎯 **精密な顧客発見** - 多次元検索条件により、ターゲットユーザーグループを迅速に特定し、マーケティング効率を向上

📧 **自動化メッセージマーケティング** - 一括メッセージ送信とテンプレート管理をサポートし、人件費を大幅に削減

👥 **顧客関係管理** - 完全なユーザー情報管理とグループ機能により、きめ細かい運営を実現

📊 **データ駆動型意思決定** - 詳細な検索結果分析と送信効果統計を提供し、マーケティング戦略を最適化

<img width="3360" height="1720" alt="CleanShot 2025-07-31 at 16 25 03@2x" src="https://github.com/user-attachments/assets/1a131a5a-80f1-4c9d-a5d4-f39ec30228da" />
<img width="3386" height="1744" alt="CleanShot 2025-07-31 at 16 25 31@2x" src="https://github.com/user-attachments/assets/3a0ac797-8a49-4bee-84a4-657e76afb640" />
<img width="3398" height="1736" alt="CleanShot 2025-07-31 at 16 25 46@2x" src="https://github.com/user-attachments/assets/3e74e7dc-7751-490f-94b2-6fec35aa6b03" />

### 適用シーン

- **Eコマースマーケティング**: 潜在的な購入者を見つけ、製品とサービスを宣伝
- **B2B営業**: 企業の意思決定者を発見し、ビジネス関係を構築
- **ブランドプロモーション**: オピニオンリーダーとターゲットオーディエンスを見つけ、ブランド影響力を拡大
- **市場調査**: ユーザーフィードバックを収集し、市場トレンドを理解
- **カスタマーサービス**: 顧客に積極的に連絡し、パーソナライズされたサービスを提供

## 技術スタック

### フロントエンド技術スタック
- **Vue 3** - プログレッシブJavaScriptフレームワーク (Composition API)
- **TypeScript** - 型安全なJavaScriptスーパーセット
- **Element Plus** - Vue 3ベースのコンポーネントライブラリ
- **Vue Router 4** - Vue.js公式ルーティングマネージャー
- **Pinia** - Vueの状態管理ライブラリ
- **Vite** - 次世代フロントエンドビルドツール
- **Vue I18n** - Vue.js国際化プラグイン
- **Axios** - HTTPクライアントライブラリ
- **@vueuse/core** - Vue Composition APIユーティリティ

### バックエンド技術スタック
- **FastAPI** - モダンで高速なWebフレームワーク
- **SQLAlchemy** - Python SQLツールキットとORM
- **SQLite** - 軽量データベース
- **Pydantic** - データ検証と設定管理
- **Uvicorn** - ASGIサーバー
- **Alembic** - データベースマイグレーションツール
- **Celery** - 分散タスクキュー
- **Beautiful Soup** - HTML/XML解析ライブラリ
- **Apify Client** - Webスクレイピングプラットフォームクライアント

### デプロイ技術スタック
- **Docker** - コンテナ化デプロイ
- **Nginx** - リバースプロキシと静的ファイルサービス
- **Docker Compose** - マルチコンテナアプリケーションオーケストレーション

## 主要機能モジュール

### 1. ユーザー管理システム
- **ユーザー情報管理**: ユーザー情報の作成、編集、削除、クエリ
- **ユーザーグループ管理**: ユーザーグループと権限管理
- **バッチ操作**: バッチインポートとユーザーデータ操作をサポート
- **ユーザーステータス管理**: ユーザーのアクティベーション、無効化などのステータス制御

### 2. メッセージシステム
- **メッセージテンプレート管理**: メッセージテンプレートの作成、編集、削除
- **メッセージタスク管理**: メッセージ送信タスクの作成と実行
- **送信記録追跡**: メッセージ送信履歴とステータスの表示
- **テンプレート変数サポート**: 動的変数置換をサポート

### 3. 検索機能
- **検索タスク管理**: 検索タスクの作成、設定、実行
- **検索結果表示**: 多次元検索結果の表示
- **データエクスポート機能**: 検索結果データのエクスポートをサポート
- **検索履歴記録**: 検索履歴の保存と表示

### 4. システム設定
- **システムパラメータ設定**: 基本システム設定とパラメータ管理
- **プロキシ設定管理**: ネットワークプロキシの設定と管理
- **ダッシュボード統計**: システム運用状況とデータ統計
- **設定バックアップ・復旧**: システム設定のバックアップと復旧

## プロジェクト構造

```
SNS_web_corsur_X搜索功能実現版本/
├── frontend/                    # フロントエンドプロジェクトディレクトリ
│   ├── src/
│   │   ├── views/              # ページコンポーネント (17ビュー)
│   │   │   ├── HomeView.vue    # ホームページ
│   │   │   ├── UserView.vue    # ユーザー管理
│   │   │   ├── MessageView.vue # メッセージ管理
│   │   │   ├── SearchResultView.vue # 検索結果
│   │   │   └── ...
│   │   ├── components/         # 共通コンポーネント (8コンポーネント)
│   │   ├── api/               # APIインターフェース定義 (9モジュール)
│   │   ├── stores/            # Pinia状態管理 (3ストア)
│   │   ├── router/            # ルート設定
│   │   ├── types/             # TypeScript型定義 (9型ファイル)
│   │   ├── utils/             # ユーティリティ関数 (6ユーティリティモジュール)
│   │   ├── services/          # ビジネスサービス (6サービス)
│   │   ├── hooks/             # Vue Composition関数 (2フック)
│   │   └── i18n/              # 国際化設定
│   ├── public/                # 静的リソース
│   ├── package.json           # フロントエンド依存関係設定
│   ├── vite.config.ts         # Viteビルド設定
│   ├── tsconfig.json          # TypeScript設定
│   └── Dockerfile             # フロントエンドDocker設定
├── backend/                    # バックエンドプロジェクトディレクトリ
│   ├── api/                   # APIルートモジュール (12ルートファイル)
│   │   ├── users.py           # ユーザー関連API
│   │   ├── messages.py        # メッセージ関連API
│   │   ├── search_tasks.py    # 検索タスクAPI
│   │   ├── templates.py       # テンプレート管理API
│   │   └── ...
│   ├── models/                # データモデル (21モデル)
│   ├── schemas/               # Pydanticスキーマ (27スキーマ)
│   ├── services/              # ビジネスロジックサービス (8サービス)
│   ├── utils/                 # ユーティリティ関数
│   ├── alembic/               # データベースマイグレーション
│   ├── main.py                # FastAPIアプリケーションエントリ
│   ├── requirements.txt       # Python依存関係
│   ├── init_db.py            # データベース初期化スクリプト
│   └── Dockerfile            # バックエンドDocker設定
├── docker-compose.yml         # Dockerオーケストレーション設定
├── nginx.conf                 # Nginxリバースプロキシ設定
├── deploy.sh                  # 自動デプロイスクリプト
├── API_PORTS.md              # APIポート設定ドキュメント
└── README.md                 # プロジェクトドキュメント
```

## クイックスタート

### 環境要件

- **Node.js** 18.0+
- **Python** 3.8+
- **npm** または **yarn**
- **Git**

### ローカル開発環境セットアップ

#### 1. プロジェクトクローン
```bash
git clone <repository-url>
cd SNS_web_corsur_X搜索功能実現版本
```

#### 2. バックエンドサービス起動
```bash
cd backend

# Python仮想環境作成（推奨）
python -m venv venv

# 仮想環境アクティベート
# macOS/Linux:
source venv/bin/activate
# Windows:
venv\Scripts\activate

# Python依存関係インストール
pip install -r requirements.txt

# データベース初期化
python init_db.py

# バックエンドサービス起動
python main.py --port 8081
# またはuvicornを使用
uvicorn main:app --reload --host 0.0.0.0 --port 8081
```

#### 3. フロントエンドサービス起動
```bash
cd frontend

# Node.js依存関係インストール
npm install

# フロントエンド開発サーバー起動
npm run dev
```

#### 4. アプリケーションアクセス
- **フロントエンドアプリケーション**: http://localhost:5173
- **バックエンドAPIドキュメント**: http://localhost:8081/docs
- **ヘルスチェック**: http://localhost:8081/health

### Dockerコンテナ化デプロイ

#### 1. Dockerイメージビルド
```bash
# フロントエンドイメージビルド
cd frontend
docker build -t sns-web-frontend .

# バックエンドイメージビルド
cd ../backend
docker build -t sns-web-backend .
```

#### 2. Docker Composeで起動
```bash
# プロジェクトルートディレクトリに戻る
cd ..

# 全サービス起動
docker-compose up -d

# サービス状態確認
docker-compose ps

# ログ表示
docker-compose logs -f
```

#### 3. コンテナ化アプリケーションアクセス
- **アプリケーションアドレス**: http://localhost:8000

### 本番環境デプロイ

提供された自動デプロイスクリプトを使用：
```bash
# 実行権限付与
chmod +x deploy.sh

# デプロイ実行
./deploy.sh
```

## 設定説明

### 環境変数設定

#### バックエンド環境変数 (backend/.env)
```env
# データベース設定
DATABASE_URL=sqlite:///./sns_web.db

# Apifyスクレイピング設定
APIFY_API_TOKEN=your_apify_api_token
APIFY_INSTAGRAM_ACTOR=your_instagram_actor_id

# その他の設定
ENV=development
DB_PRESERVE_DATA=true
```

#### フロントエンド環境変数 (frontend/.env)
```env
# APIベースURL
VITE_API_BASE_URL=http://localhost:8081
```

### ポート設定詳細

| サービス | 開発環境ポート | 本番環境ポート | 説明 |
|----------|---------------|---------------|------|
| フロントエンド開発サーバー | 5173 | - | Vite開発サーバー |
| バックエンドAPIサーバー | 8081 | 8081 | FastAPIアプリケーションサーバー |
| Nginxリバースプロキシ | - | 8000 | 本番環境統一エントリ |

詳細設定については、[API_PORTS.md](./API_PORTS.md)を参照してください。

## APIドキュメント

### 主要APIエンドポイント

| モジュール | APIパス | 機能説明 |
|-----------|---------|----------|
| ユーザー管理 | `/api/users` | ユーザーCRUD操作 |
| ユーザーグループ管理 | `/api/user-groups` | ユーザーグループ管理 |
| メッセージ管理 | `/api/messages` | メッセージとメッセージタスク管理 |
| 検索タスク | `/api/search-tasks` | 検索タスクCRUD |
| テンプレート管理 | `/api/templates` | メッセージテンプレート管理 |
| プロキシ設定 | `/api/proxy` | ネットワークプロキシ設定 |
| ダッシュボード | `/api/dashboard` | 統計データ取得 |
| システム設定 | `/api/configs` | システムパラメータ設定 |

### APIドキュメントアクセス

バックエンドサービス起動後、以下のアドレスで完全なAPIドキュメントにアクセスできます：
- **Swagger UI**: http://localhost:8081/docs
- **ReDoc**: http://localhost:8081/redoc

## トラブルシューティング

### よくある問題

1. **ポート占有**
   ```bash
   # ポート占有確認
   lsof -i :5173  # フロントエンドポート
   lsof -i :8081  # バックエンドポート
   
   # 占有プロセス終了
   kill -9 <PID>
   ```

2. **データベース問題**
   ```bash
   # データベース再初期化
   cd backend
   python init_db.py
   ```

3. **依存関係問題**
   ```bash
   # フロントエンド依存関係問題
   cd frontend
   rm -rf node_modules package-lock.json
   npm install
   
   # バックエンド依存関係問題
   cd backend
   pip install -r requirements.txt --force-reinstall
   ```

### ログ確認

- フロントエンドログ: ブラウザ開発者ツールコンソール
- バックエンドログ: `backend/logs/app.log`
- Nginxログ: `/data/karry/sns-web/logs/nginx/`

## 開発ガイドライン

### フロントエンド開発規約

1. **Vue 3 Composition APIを使用**
2. **TypeScript型制約に従う**
3. **Element Plusコンポーネントライブラリを使用**
4. **Piniaを統一的に状態管理に使用**
5. **axiosをAPIインターフェースに統一的に使用**

### バックエンド開発規約

1. **FastAPIフレームワークを使用**
2. **RESTful API設計に従う**
3. **Pydanticをデータ検証に使用**
4. **SQLAlchemy ORMを使用**
5. **ビジネスロジックをservicesレイヤーにカプセル化**

## 更新ログ

### v1.0.0 (現在のバージョン)
- ✅ 完全なユーザー管理システム
- ✅ メッセージテンプレートとタスク管理
- ✅ 検索機能実装
- ✅ システム設定とダッシュボード
- ✅ Dockerコンテナ化デプロイ
- ✅ 完全なAPIドキュメント

## 技術サポート

使用中に問題が発生した場合は、以下をご確認ください：

1. このドキュメントのトラブルシューティングセクションを確認
2. [API_PORTS.md](./API_PORTS.md)設定説明を確認
3. プロジェクトIssuesを確認
4. 開発チームに連絡

---

**注意**: 本番環境デプロイ前に、データベースパスワード、APIキーなどの機密情報を含むデフォルトのセキュリティ設定を変更してください。
