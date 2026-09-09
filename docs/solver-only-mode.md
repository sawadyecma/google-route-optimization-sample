# Route Optimization API を「ソルバーだけ」使う（調査メモ）

前回の [特定の道路・区間を避ける](./avoid-specific-roads.md) は「Google の経路計算に手を入れて特定区間を避けさせる」方向で、これは無理だと分かった。本メモは**発想を逆にした調査**の記録である。すなわち:

> 移動時間・距離は自前（or 別エンジン）で作る。Google の Route Optimization API には**組み合わせ最適化（ソルバー）だけをやらせる**。地図描画も自前でやる。

**結論: 技術的には成立する。** 行列モードでも制約モデル（休憩・積載・時間枠・スキップ・優先順・不可分）はほぼ全部生きており、非対称行列も正しく効く。破綻するのは「Google が座標を前提にする機能」だけ（ポリライン・渋滞・routeModifiers）で、これは元々自前でやる前提なので設計上の矛盾はない。**採用可否を決めるのは技術ではなく、`4MiB` のリクエスト上限（≒ 同期リクエストで約 580 地点）と、行列を毎回作るコストをどう払うか**の2点。

## 構成イメージ

```
[自前 or OSS 経路エンジン]            [Route Optimization API]        [自前フロント]
 Valhalla / OSRM / 実績データ  ──▶  行列注入して最適化だけ依頼  ──▶  訪問順を受け取る
   ・区間ペナルティ                    ・休憩/積載/時間枠/コスト        ・描画は経路エンジンの
   ・一方通行/非対称                   ・スキップ/優先順/不可分           ポリラインを別途取得
   ・時間帯別の所要時間                 ・返るのは「順序と時刻」だけ
```

つまり Google に渡すのは「地点間の移動コスト表」と「制約」だけ。返ってくるのは「どの車がどの順で回るか、各訪問の時刻」だけ。**地図に線を引くのは Google の仕事ではなくなる**（ここが前回不採用の理由だったが、ソルバー用途と割り切るなら仕様どおりの挙動）。

## 実機検証（本プロジェクトの認証で `optimizeTours` を実際に叩いた結果）

行列モード = `durationDistanceMatrixSrcTags` / `DstTags` / `durationDistanceMatrices` をセットし、座標を一切送らない構成。4地点（D=拠点, A/B/C）3配送・1車両の最小モデルで検証した。

### 使える機能（200 OK・意図どおり動作）

| 機能 | フィールド | 検証結果 |
|---|---|---|
| 基本の最適化 | — | ⭕ 訪問順・各訪問時刻・`transitions[].travelDuration/travelDistanceMeters` が返る |
| **非対称行列** | 行列値 | ⭕ **効く。** 時計回りだけ安い行列 → `A>B>C`、転置（反時計回りだけ安い）→ `C>B>A` に反転。一方通行・上り下り・時間帯別を表現できる |
| 休憩 | `vehicles[].breakRule` | ⭕ `routes[].breaks[]` が返る（既存 Web UI の機能はそのまま移植可） |
| 積載量 | `loadDemands` / `loadLimits` | ⭕ 容量超過で2台に分割された |
| スキップ許容 | `shipments[].penaltyCost` | ⭕ `routeDurationLimit` を絞ると `skippedShipments` に落ちる |
| 各種コスト | `costPerHour` / `costPerTraveledHour` / `costPerKilometer` | ⭕ `metrics.costs` に内訳（`model.vehicles.cost_per_kilometer` 等）が返る |
| ハード時間枠（訪問） | `VisitRequest.timeWindows` | ⭕ 縛れるのは**到着（訪問開始）時刻**のみ。「出発を縛りたい」場合は作業時間ぶん前倒しした到着枠に変換する |
| 車両の出発・帰着時間枠 | `vehicles[].startTimeWindows` / `endTimeWindows` | ⭕ 出発地を出てよい時間帯 / 帰着地に着くべき時間帯 |
| ソフト時間枠 | `softEndTime` / `costPerHourAfterSoftEndTime` | ⭕ |
| 区間ペナルティ | `transitionAttributes` | ⭕ タグ間コスト/遅延が効き、嫌った辺を避けた順序になった。**行列用タグと属性タグは同じ訪問に併記できる** |
| 移動時間の倍率 | `vehicles[].travelDurationMultiple` | ⭕ **注入した行列の `durations` に掛かる**（`600s→1200s`）。`meters` には掛からない |
| **車両タイプ別の行列** | `DurationDistanceMatrix.vehicleStartTag` | ⭕ 「速い車用」「遅い車用」の2行列を同時に渡せた（`vehicleStartTag` を `startTags` に持たせる） |
| 優先順・不可分 | `precedenceRules` / `shipmentTypeIncompatibilities` | ⭕ |
| 再最適化 | `injectedFirstSolutionRoutes` | ⭕ 前回解を初期解として渡せる（手直し後の再計算に使える） |
| 同一地点への複数訪問 | 同じタグを複数 `VisitRequest` で共有 | ⭕ **タグ数 = 地点数**で、訪問数と一致させる必要はない |

### 使えない機能（400 になる。エラーメッセージ実測）

| やろうとしたこと | エラー |
|---|---|
| `populatePolylines` / `populateTransitionPolylines` | `geolocations are required when setting this option (populate_pathfinder_trips)` |
| 座標との混在（一部の訪問だけ `arrivalWaypoint`） | `geolocations are incompatible with index-based locations` |
| `useGeodesicDistances` | `geolocations are required when setting this option (use_geodesic_distances)` |
| `considerRoadTraffic`（渋滞考慮） | `geolocations are required when setting this option (pathfinder_cost_model_options)` |
| `travelMode` / `routeModifiers`（有料道回避等） | `geolocations are required when setting 'pathfinder_cost_model_options_override'` |
| `meters` を省いたまま距離系フィールドを使う | `the model uses location indices ... contains distance-related fields (route_distance_limit, cost_per_kilometer ..) but its 'duration_distance_matrices' is empty` |
| 座標の代わりに index を直接指定（`arrivalIndex` / `startIndex`） | `Unknown name "arrivalIndex" ... Cannot find field`（内部的には index だが、公開 API は**タグ経由のみ**） |

補足: `meters` は**距離系フィールド（`costPerKilometer` / `routeDistanceLimit`）を一切使わなければ省略できる**（`durations` だけの行列で 200 OK）。ペイロード削減に効く。

### 定量的な上限（実測）

同期 `optimizeTours` のリクエスト上限は **4,194,304 bytes（4MiB）**。エラー文言も `Request payload size exceeds the limit: 4194304 bytes.` と明示的。行列は 1 セルおよそ 12 bytes（`durations`+`meters`、値は数百秒スケール）なので:

| 行列サイズ | セル数 | リクエスト | 結果 | 所要 |
|---|---|---|---|---|
| 302 × 302 | 91,204 | 1.06 MB | ⭕ 200 | 7.0s |
| 580 × 580 | 336,400 | 3.86 MB | ⭕ 200 | 19.9s |
| 702 × 702 | 492,804 | 5.63 MB | ❌ 4MiB 超過 | 25.3s |
| 802 × 802（`meters` 省略） | 643,204 | 4.33 MB | ❌ 4MiB 超過 | 19.1s |

→ **同期リクエストの実用上限は 550〜600 地点程度**（`durations` のみなら 750 前後）。それ以上は `batchOptimizeTours`（非同期・GCS 入出力・リクエストサイズ上限 100MB）に逃がす必要がある。なお 3.86MB のリクエストは `timeout: 10s` でも往復 20 秒かかった（アップロード＋バリデーションが支配的）ので、UI 同期呼び出しの体感も設計に入れること。

### タグ運用の落とし穴

`durationDistanceMatrixSrcTags` に**実際には誰も使っていないタグを混ぜると 400**:

```
in the set of values spanned by all 'departure_index' and 'start_index' fields: : index #2 is missing
the (implicit) number of matrix, departure_/start_ and arrival_/end_ indices (1x3x3)
  does not correspond to the size of `duration_distance_matrices` (2500 elements)
```

内部ではタグ→index に変換されており、**「使われている index の集合が 0..n-1 を隙間なく埋める」ことが要求される**。よって「地点マスタ全件の行列を作って、今日使う分だけ訪問を作る」という運用は不可。**行列は毎回「そのリクエストで実際に登場する地点だけ」に絞って生成する**必要がある（＝リクエストごとに行列を作り直す前提）。

さらに、**この検証は出発側（`departure_index` / `start_index`）と到着側（`arrival_index` / `end_index`）で別々に走る**。出発地と帰着地が違うルート（片道）を組むと、帰着地は**到着側にしか登場しない**ため、src タグに混ぜた瞬間に落ちる:

```
in the set of values spanned by all 'departure_index' and 'start_index' fields: : index #1 is missing
```

つまり **`durationDistanceMatrixSrcTags` と `DstTags` は同じリストである必要がない**（というより、片道ルートでは同じにしてはいけない）。正しくは:

| | 中身 | 行列 |
|---|---|---|
| `durationDistanceMatrixSrcTags` | 出発地 + 訪問先 | 行 |
| `durationDistanceMatrixDstTags` | 帰着地 + 訪問先 | 列 |

**行列は正方とは限らず矩形になる。** `rows` 数 = src タグ数、各 `row.durations` / `row.meters` 数 = dst タグ数、という仕様どおりに組めばよい（出発地と帰着地が同じ拠点なら結果的に正方行列になる）。

### レスポンスに何が返るか（描画設計に直結）

```
routes[].visits[]      : shipmentIndex / visitRequestIndex / startTime / detour / visitType   ← 座標は返らない
routes[].transitions[] : travelDuration / travelDistanceMeters / waitDuration / totalDuration / startTime / delayDuration
routes[].metrics       : travelDuration / visitDuration / breakDuration / totalDuration / travelDistanceMeters
routes[].routeCosts, routeTotalCost, vehicleStartTime, vehicleEndTime, vehicleFullness
metrics.costs          : コスト内訳（cost_per_hour / cost_per_kilometer ...）
routes[].routePolyline : 返らない
```

`shipmentIndex` で自前の地点データに引き当てる形になる。座標は自分が持っているので実害はないが、**描画用のポリラインは行列を作った経路エンジンから別途取得して合成する**設計が必須。

### 時間枠の扱い（実測）

行列モードでも時間制約はそのまま使える。UI では 3 種類を出し分けている。

| 対象 | API フィールド | 意味 |
|---|---|---|
| 全体 | `model.globalStartTime` / `globalEndTime` | 全ルートが収まるべき範囲。UI の既定は**当日 8:00〜23:00** |
| S（出発地） | `vehicles[].startTimeWindows` | 車両が出発地を出てよい時間帯 |
| E（帰着地） | `vehicles[].endTimeWindows` | 車両が帰着地に着くべき時間帯 |
| 訪問先 | `shipments[].deliveries[].timeWindows` | **到着（訪問開始）時刻**の許容時間帯 |

UI の入力は**時刻（hh:mm）のみ**で、日付は当日固定にしている（日をまたぐ行程を組みたくなったら
`useSolverModel.ts` の `TODAY` を可変にする）。

注意点は **`VisitRequest.timeWindows` が縛れるのは到着時刻だけ**で、「その地点を何時までに出発したい」を
直接表すフィールドがないこと。UI では「出発」を選んだ場合、`到着枠 = 出発枠 − 作業時間` に変換して送っている
（作業時間 15 分・出発 15:00 以降 → `startTime` は 14:45 として送る）。

仮想フィールド版での実測（S 出発 10:00〜10:30 / B 到着 13:00 まで / C 出発 15:00 以降）:

```
10:14 出発(A) → 11:29 H → 12:53 B → 14:45 C（15:00 出発）→ 15:41 J → …
```

3 つの枠が同時に効き、B は最後（23:19）から 2 番目（12:53）へ繰り上がった。

### 時間内に回りきれないと「スキップ」で返る（実測）

`penaltyCost` を付けていない＝必須のはずの shipment でも、**全体時間枠に収まらない分は
`skippedShipments` に落として解を返してくる**（エラーにはならなかった）。

**`penaltyCost` を上げても防げない。** `penaltyCost: 1e9` を全 shipment に付けて再実験しても
スキップされる地点はまったく同じで、`metrics.costs` に `model.shipments.penalty_cost: 4e9` が
積まれるだけだった。落ちた地点の `reasons` は `CANNOT_BE_PERFORMED_WITHIN_VEHICLE_TIME_WINDOWS`
で、コストの問題ではなく**枠に物理的に入らない**ことが理由。

実地図版の既定（10 地点・60km/h・当日 8:00〜23:00）だと 1 日で回りきれないため、実測では:

```
08:00 東京都庁 → 群馬 → 長野 → 静岡 → 神奈川 → 高輪 → 21:01 東京都庁（11時間46分 / 706.1km）
訪問できなかった地点（4）: 愛知県庁, 石川県庁, 新潟県燕市, 京都府庁
```

UI では未訪問の地点を**オレンジ**で描き分け、「終了時刻を延ばす・平均速度を上げる・訪問先を減らす」
という解消手段を添えている。1 日で全 10 地点を回りたいなら、平均速度を上げるか終了時刻を翌日側へ
延ばす必要がある。

### スキップをなくす唯一の手段は「枠を広げる」（実測）

上記のとおり効くのは枠だけなので、UI の「**どの地点もスキップさせない**」は
**全体終了時刻を自動で延長する**という実装にしてある。延長幅は行列から求めた
「どんな訪問順でも必ず収まる上限」（最長区間 × 区間数 + 作業時間の総和）で、
個別の時間枠が指定されていればその最終時刻を基準に足す。

枠を広げても解は悪化しない。同じモデルで `globalEndTime` を +3 日 / +30 日 / +365 日と
振って実測したところ、**3 回とも訪問順・帰着時刻・総コストが完全に一致**した
（`vehicleEndTime` は 3 回とも `2026-09-10T01:57:12Z`）。車両コストが時間あたりで効くため、
枠をいくら広げてもソルバーは最短の解を返す。枠は上限であって目標ではない。

なお E（帰着）や各地点に**明示した**時間枠はそのまま残すので、それ自体が守れない地点は
このチェックを入れても依然スキップされる。

## 設計上の含意

1. **描画は別レイヤーになる。** 「訪問順（RO）」と「線（経路エンジン）」を別々に取得して重ねる。訪問順が確定してから区間ポリラインを引くので、必要な経路取得は N-1 本だけ（全ペアは不要）。
2. **時間帯別の所要時間は「車両を分ける」で近似できる。** RO の行列は時間非依存（1車両タイプに1行列）。ただし `vehicleStartTag` で車両ごとに別行列を渡せるので、「午前便の車両／午後便の車両」を別車両＋別行列としてモデル化すれば時間帯差をある程度表現できる。厳密な time-dependent VRP は無理。
3. **課金は減らない。** RO の料金は shipment 単位（車両台数は Single Vehicle / Fleet の SKU 区分にのみ影響）。Google の道路計算を使わなくても RO 側の請求は変わらないので、**行列生成コストは純増**。Routes API の `computeRouteMatrix` で行列を作ると1リクエスト 625 要素上限＋要素課金なので、580 地点（33.6万要素）では現実的でない。**自前 OSRM / Valhalla を立てる前提でしか成立しない。**
4. **API 一貫性の副作用として得るもの。** 休憩・積載・スキップ・ソフト時間枠・コスト内訳といった「自分で書くと面倒な制約」を維持したまま行列だけ差し替えられるのは大きい。既存 Web UI（`costPerHour` / `breaks` / `penaltyCost` 前提）はモデル部分をほぼ触らずに移行できる。

## で、OR-Tools ではなくこれを選ぶ理由があるか

行列を自前で作るなら、ソルバーも OR-Tools（無料・自前ホスト）でよいのでは、という当然の対抗案がある。判断軸:

| | RO API をソルバーとして使う | OR-Tools 自前 |
|---|---|---|
| 制約モデルの実装コスト | ⭕ 休憩・積載・ソフト時間枠・スキップ・優先順が**宣言的に書ける** | ❌ 全部自分で Dimension / Disjunction を組む |
| 運用 | ⭕ マネージド。チューニング不要 | ❌ ソルバーのパラメータ・実行環境・スケールを自前で持つ |
| コスト | ❌ shipment 単位で課金され続ける | ⭕ 計算資源のみ |
| 上限 | ❌ 同期 4MiB（約 580 地点）、`batch` へ逃げると非同期運用 | ⭕ メモリ次第 |
| 拡張性 | ❌ 用意された制約しか使えない | ⭕ 任意の制約を書ける |

**「制約が Google の用意した範囲で足りる」かつ「地点数が数百以内」なら RO をソルバーとして使うのは十分合理的。** 逆に、独自制約が増える／地点数が千を超える見込みなら OR-Tools に寄せたほうが素直。前回の「特定区間を避けたい」という要求は**行列側（経路エンジン）で解決される**ので、この構成なら両立する。

## 次にやるなら

- [ ] 経路エンジン（Valhalla or OSRM）を1つ立てて、実データで N=100〜300 の行列生成にかかる時間を測る
- [ ] 既存 Web UI を「行列モード＋区間ポリライン合成」で描画できるか試作（訪問順確定後に N-1 本の経路を引く）
- [ ] `batchOptimizeTours` 経由で 1000 地点級が通るか（GCS 入力・非同期の運用込みで）検証
- [ ] `vehicleStartTag` 別行列での時間帯モデル化が、実務の要求（朝夕の渋滞差）に足りるか評価

## 動く最小サンプル（10 地点）

`app/cmd/src/solverOnly.ts` に、10 地点（東京都庁を拠点に、県庁所在地＋高輪・燕市）でこの構成を
実際に回す CLI を置いた。

```bash
make dev-solver                                  # 方向別ペナルティあり
npm run --workspace=cmd dev:solver -- --no-penalty  # 対称行列との対照実行
```

やっていること:

1. 10 地点の座標から**自前で 10x10 の行列を生成**（haversine × 迂回係数 1.35 ÷ 平均 60km/h）
2. 一部の向きだけ係数を掛けて**非対称化**（`DIRECTIONAL_PENALTIES`。実運用では経路エンジンの出力に置き換える想定）
3. 座標を送らず tags だけで `optimizeTours` を呼ぶ
4. 返ってきた訪問順・時刻・区間所要を `shipmentIndex` で自前の地点データに引き当てて表示

出力例（ペナルティあり／なしを並べたもの）:

```
[penalty OFF] 東京都庁 → 高輪 → 神奈川 → 静岡 → 愛知 → 京都 → 石川 → 長野 → 燕市 → 群馬 → 東京都庁
[penalty ON]  東京都庁 → 群馬 → 燕市 → 長野 → 石川 → 京都 → 愛知 → 静岡 → 神奈川 → 高輪 → 東京都庁
両者とも 移動 24時間42分 / 1482.2km / 総コスト 140148（帰着はどちらも翌日 10:57）
```

**周回の向きがそのまま反転する。** 対称行列では周回方向を反転してもコストが変わらないので、実際に使われている向きだけを重くすると、解全体が逆回りに切り替わって同じコストに収まる。行列の非対称性が最適化に効いていることの確認になる（逆に言うと、ペナルティを置く向きを間違えると何も起きない — 最初の試行では元々通らない向きを重くしていて出力が完全に同一だった）。

所要は 10 地点なら往復 1.2〜1.3 秒、リクエストは 3.1KB（4MiB 上限に対して余裕）。
なお CLI 版は 10 地点を 1 台で回ると 27 時間かかるため、全体時間枠を 2 日ぶん取ってある
（日をまたぐ訪問は `M/D HH:MM` 表記）。**Web UI 側は当日 8:00〜23:00 の 1 日運用**にしてあるので、
収まらない地点はスキップされる（下記）。

### UI で触る（Route Studio のソルバー Playground）

同じロジックを Web UI からも触れる。`make dev-server` と `make dev-web` を起動し、ヘッダーのタブから
**2 種類**の Playground を選ぶ。

| タブ | 地点 | 距離の測り方 | 何を見る用か |
|---|---|---|---|
| **ソルバー（実地図）** | Google マップ上の実座標 | haversine × 迂回係数 | 実データでの訪問順・所要時間 |
| **ソルバー（仮想フィールド）** | 300×200km のフレーム上の XY | **座標の直線距離そのまま** | 地理に邪魔されず、行列の値と最適解の関係だけを観察する |

どちらも中身（行列生成 → 注入 → 訪問順の描画）は共通で、違うのは「地点の座標系」と「距離の測り方」だけ。
共通ロジックは `app/web/src/lib/useSolverModel.ts`、共通 UI は `app/web/src/components/SolverSidebar.tsx`。

- 初期状態は 10 地点（実地図版は県庁所在地＋高輪・燕市、仮想フィールド版は A〜J）。
  **地点は消さずチェックで出し入れ**する（クリックで追加・ドラッグで移動も可）。
  「**全部外す**」は選択だけを外して地点は残す、「**全部除去**」は地点そのものを消して
  まっさらな状態から置き直す（「初期状態に戻す」でいつでも復帰できる）
- **S（出発地）/ E（帰着地）を地点ごとに指定できる。** 別々にすると片道ルートになり、行列も矩形（src ≠ dst）になる
- 迂回係数 / 平均速度 / 作業時間 / コストをその場で変更でき、行列が即座に再生成される
- 生成された行列を表形式で確認できる（**往復で値が違うセルは赤**なので、ペナルティがどこに効いたか一目で分かる）
- 送信する JSON をそのまま開けるので、座標が含まれていないことを確認できる
- 結果の各区間に「**この向きを重くする**」ボタンがある。**最適解が実際に通っている向き**にペナルティを置けるので、
  「重くしたのに何も起きない」を避けられる
- **時間枠**を S（出発時刻）・E（帰着時刻）・各訪問先（到着 or 出発）にレンジで指定できる。
  片側だけ（「この時刻まで」だけ等）の指定も可。既定は**当日内の時刻だけ**を扱うが、
  「**日付も指定する**」を ON にすると各枠に日付欄が出て、**日をまたぐ行程**を組める
- 「**どの地点もスキップさせない**」チェックボックスで、全体時間枠を自動延長して未訪問をなくせる（下記）
- 「いまの結果を比較用に保存」→ ペナルティを切り替えて再実行すると、訪問順が
  **完全な逆回りに反転したかどうか**を判定して表示する

なお行列モードでは地図上の線は直線になる（道路形状が返らない）。UI 側にもその旨を明示している。
仮想フィールド版はそもそも道路の概念がないので、**この制約が制約に見えない**のが利点でもある。

仮想フィールド版での確認例（A を出発・帰着に固定、B→J と E→F を 3 倍）:

```
[penalty ON]  A → H → G → F → E → D → J → C → I → B → A
[penalty OFF] A → B → I → C → J → D → E → F → G → H → A（12時間40分 / 760.4km / コスト 75187）
```

実地図版とまったく同じで、片方向だけ重くすると周回が逆回りに反転する。

## 再現用リクエスト骨格

```jsonc
{
  "timeout": "10s",
  // populatePolylines / considerRoadTraffic は付けない（400 になる）
  "model": {
    "globalStartTime": "2026-03-02T00:00:00Z",
    "globalEndTime": "2026-03-02T12:00:00Z",
    "durationDistanceMatrixSrcTags": ["loc-D", "loc-A", "loc-B"],  // 実際に使う地点のみ・順序が行/列に対応
    "durationDistanceMatrixDstTags": ["loc-D", "loc-A", "loc-B"],
    "durationDistanceMatrices": [{
      // vehicleStartTag: "veh-truck"  ← 車両タイプ別に複数行列を渡す場合のみ
      "rows": [
        { "durations": ["0s", "600s", "900s"],  "meters": [0, 4800, 7200] },   // loc-D 発
        { "durations": ["600s", "0s", "300s"],  "meters": [4800, 0, 2400] },   // loc-A 発
        { "durations": ["1500s", "300s", "0s"], "meters": [12000, 2400, 0] }   // loc-B 発（非対称でよい）
      ]
    }],
    "shipments": [
      { "deliveries": [{ "tags": ["loc-A"], "duration": "60s" }] },  // 座標は送らない
      { "deliveries": [{ "tags": ["loc-B"], "duration": "60s" }] }
    ],
    "vehicles": [
      { "startTags": ["loc-D"], "endTags": ["loc-D"], "costPerHour": 30, "costPerKilometer": 1 }
    ]
  }
}
```

## 参考リンク

- `ShipmentModel`（行列・タグ規則）: https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/ShipmentModel
- `optimizeTours`（`populatePolylines` / `injectedFirstSolutionRoutes` 等）: https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/projects/optimizeTours
- 課金と上限（QPM 60 / batch は 100MB・100件）: https://developers.google.com/maps/documentation/route-optimization/usage-and-billing
- 前段の調査: [特定の道路・区間を避ける](./avoid-specific-roads.md)
