// チュートリアルツアーのステップ定義（表示順 = 配列順）。
// target は EditorPage 側の data-tour 属性値と対応。未指定なら画面中央に表示する。

export type TourStep = {
  target?: string;
  title: string;
  body: string;
};

export const TOUR_STEPS: TourStep[] = [
  {
    title: 'Route Studio へようこそ 👋',
    body: 'このツアーで配送ルート最適化の基本的な使い方を紹介します。地点を置いて条件を決めると、最適な巡回ルートを計算できます。所要 1 分・いつでもスキップできます。',
  },
  {
    target: 'mode',
    title: '① 追加する地点の種別を選ぶ',
    body: '地図クリックで追加する地点の種別をここで選びます。出発(S)・帰着(E)・荷物の集荷(Pickup)・配達(Delivery) の 4 種類です。',
  },
  {
    target: 'map',
    title: '② 地図に地点を配置',
    body: '地図をクリックすると、選択中の種別で地点が追加されます。まず S と E を 1 つずつ、続けて Pickup と Delivery を同数ずつ置きましょう（index 順にペアになります）。',
  },
  {
    target: 'point-list',
    title: '③ 置いた地点を確認・調整',
    body: '配置した地点の一覧です。各地点に到着の時間枠（ハード／ソフト）を設定したり、Pickup 行ではスキップ時のペナルティも指定できます。',
  },
  {
    target: 'global-window',
    title: '④ 全体の時間枠',
    body: 'すべてのルートが収まる全体の時間範囲です。各地点の時間枠はこの範囲内に収めてください。',
  },
  {
    target: 'vehicle-cost',
    title: '⑤ 最適化のコスト設定',
    body: '時間・距離・固定費など、最適化が最小化する目的関数のコストです。ソフト制約の違反コストとの相対値で巡回の挙動が変わります。',
  },
  {
    target: 'calculate',
    title: '⑥ 最適化を計算',
    body: 'S/E と同数の Pickup・Delivery が揃うと押せます。クリックすると最適な巡回順とルートを計算します。',
  },
  {
    target: 'result',
    title: '⑦ 結果を見る',
    body: '移動時間・距離・合計コストや訪問スケジュール、コスト内訳が表示されます。計算した条件と結果は自動で履歴に保存されます。',
  },
  {
    target: 'history',
    title: '⑧ 履歴・サンプル',
    body: '過去の計算をいつでも復元できます。★ でお気に入り登録、サンプルタブから例を読み込んで試すこともできます。これでツアーは完了です！',
  },
];
