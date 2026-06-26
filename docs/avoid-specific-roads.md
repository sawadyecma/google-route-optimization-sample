# 特定の道路・区間を避ける／ペナルティを与える（調査メモ）

「このルート（特定の道路・区間）はできるだけ通らせたくない」を Route Optimization API で実現できるか調べた記録。**結論から言うと、API ネイティブでは「特定区間にペナルティ」はできない**。試作した「自前の移動コスト行列を注入する」回避策も、実用面で破綻したため**不採用**にした。同じ検討を繰り返さないためにここに残す。

## 何ができて、何ができないか

| やりたいこと | 手段 | 可否 |
|---|---|---|
| 有料 / 高速 / フェリーを避ける（**種類**で回避） | `routeModifiers`（`avoidTolls` / `avoidHighways` / `avoidFerries` / `avoidIndoor`） | ⭕ ソフト（保証はされない。代替が無ければ通る） |
| 特定地点ペア間の移動を割高にする | `transitionAttributes`（タグ間にコスト/遅延を上乗せ） | ⭕ ソフト誘導。ただし**道路区間単位ではない** |
| **特定の道路・任意区間にペナルティ／通行禁止** | API ネイティブ | ❌ できない |

### なぜ「区間ペナルティ」ができないのか

Route Optimization の最適化エンジンは**道路を 1 本ずつモデル化していない**。エンジンが扱うのは「地点（訪問）」「地点ペア間の移動時間・距離」「時間枠・コスト等の制約」だけで、「実際にどの道を通るか」は移動時間を計算する内部ルーティングが決める。そのため、**道路区間を名指しでコスト化する入口が存在しない**。

## 試した回避策：自前の移動コスト行列を注入（`durationDistanceMatrices`）

唯一の理屈上の手は「最適化に渡す移動時間・距離行列を自前で計算して注入する」こと。地図上に**バリア（禁止スポット：中心＋半径）**を置き、2 地点を結ぶ直線がバリア円を跨ぐ辺に大きなペナルティ係数を掛けた行列を渡せば、結果的にその区間を避けた巡回順になる、というアプローチを実装して検証した。

### 実装して分かった行列モードの制約（リファレンス＋実機 400 で確定）

`ShipmentModel` リファレンスに次の記述がある:

> If the shipment model has duration distance matrices, `arrivalLocation` must not be specified（visit・vehicle の waypoint / departure location も同様）

ここから、行列（index-based location）モードでは以下が確定:

| 項目 | 通常モード | 行列モード |
|---|---|---|
| visit の `arrivalWaypoint`(latLng) | 送る | **送らない** → 代わりに `tags` |
| 車両の `startWaypoint` / `endWaypoint` | 送る | **送らない** → 代わりに `startTags` / `endTags` |
| `populatePolylines` / `populateTransitionPolylines` | 送る | **送らない**（実座標必須のため、付けると 400） |
| `durationDistanceMatrices` + `durationDistanceMatrixSrcTags` / `DstTags` | なし | 送る |

タグの対応規則:
- 各地点に一意タグを振る（例: `loc-start` / `loc-end` / `loc-p{i}` / `loc-d{i}`）。
- `durationDistanceMatrixSrcTags[j]` が行 `j`、`durationDistanceMatrixDstTags[k]` が列 `k` に対応（ここでは src = dst の正方行列）。
- `rows` 数 = src タグ数、各 `row.durations` / `row.meters` 数 = dst タグ数。
- **各 `VisitRequest` / `Vehicle` は src・dst タグにそれぞれちょうど 1 つ一致**しなければならない。

途中で踏んだ 400 エラー（順に潰した）:
1. `geolocations are incompatible with index-based locations` … waypoint の `latLng` を送っていた → 座標を全て除去。
2. `geolocations are required when setting this option (populate_pathfinder_trips)` … `populatePolylines` を送っていた → 行列モードでは付けない。

### なぜ不採用にしたか

リクエスト自体は正式仕様に沿わせれば通せる形まで持っていけたが、用途として破綻していた:

1. **地図描画と本質的に相性が悪い。** 行列モードでは API が道路形状を計算しないため、実道路ポリラインが返らない。地図上のルートは「訪問順を結ぶ直線」でしか描けず、デモの見栄え・意味が大きく損なわれる。
2. **回避の精度が出ない。** バリア判定は「2 地点を結ぶ**直線**が円に掛かるか」の幾何近似でしかなく、実際の道路形状を見ていない。「直線的にそのスポットを跨ぐ移動を嫌う」だけで、現実の道路に厳密に沿った区間回避にはならない。
3. **全移動が直線距離ベースに退化する。** 行列値は haversine 距離＋平均速度で見積もるため、通常モード（実道路ルーティング）と所要時間の絶対値が乖離する。

> 補足: リファレンスには `useGeodesicDistances` + `geodesicMetersPerSecond`（直線距離ベースで解く公式オプション）もある。自前行列の「haversine＋速度」は実質これと同等だが、**バリアのペナルティを盛れるのは自前行列だけ**。とはいえ上記の理由で実用に至らなかった。

## 結論 / 今後やるなら

- 「種類での回避」で足りるなら **`routeModifiers`** を入れるのが現実的（実装も軽い）。
- **「特定の道路・区間を厳密に避けたい」なら、Route Optimization 単体では不可。** 区間（グラフのエッジ）単位でコストを盛れる／エリアを除外できる経路エンジン（**Valhalla / OSRM** 等。`avoid_polygons` / `exclude_locations` / エッジ重み調整に対応）で移動コスト行列を作り、それを注入する構成が前提になる。つまり「区間ペナルティ」は最適化 API の機能ではなく、**その手前の経路計算をどう作るか**の問題。
- ただし行列注入は上記 3 点（地図描画・精度・距離の退化）とのトレードオフを伴うため、採用時は描画方式や精度要件まで含めて設計する必要がある。

## 参考リンク

- Route Optimization REST リファレンス（トップ）: https://developers.google.com/maps/documentation/route-optimization/reference/rest
- `ShipmentModel`（`durationDistanceMatrices` / タグ規則）: https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/ShipmentModel
- `OptimizeToursRequest`（`populatePolylines` / `useGeodesicDistances` 等）: https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/projects/optimizeTours
- Routes API の `routeModifiers`（種類での回避）: https://developers.google.com/maps/documentation/routes/route-modifiers
