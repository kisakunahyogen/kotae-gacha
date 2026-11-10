# データ（words.json）の出典とライセンス

`docs/words.json` は、クローラーが自動で作成するデータです。項目ごとに権利の扱いが異なります。

| 項目 | 内容 | 扱い |
|---|---|---|
| `word` | ウィキペディア日本語版の記事名 | 記事名そのもの |
| `meaning` | ウィキペディア日本語版の記事冒頭の抜粋 | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.ja)。出典は各語の `wiki` の記事で、著作者はその記事の履歴に記載された執筆者です |
| `views` | Wikimedia の閲覧数統計 | Wikimedia の統計データに基づく |
| `zipf` / `level` | 日本語での使われやすさ（[wordfreq](https://github.com/rspeer/wordfreq) の頻度データ、CC BY-SA 4.0）と閲覧数から計算した値 | wordfreq のデータに基づく |
| `cats` | ウィキペディアのカテゴリ名（偏りを防ぐために使用） | ウィキペディア日本語版に基づく |
| `sources[].title` / `sources[].url` | 言葉を拾った場所（ニュースの見出し、またはウィキペディアの記事名）とリンク | `site` が Wikipedia のものは CC BY-SA 4.0。それ以外は見出しとリンク先記事の著作権が各報道機関に帰属します |
| `reading` | 形態素解析（kuromoji / IPADIC）による推定読み | 自動推定のため誤りを含むことがあります |

`meaning` を再利用する場合は、CC BY-SA 4.0 の条件（出典の表示・同じライセンスでの公開）に従ってください。
このサイトはニュース記事の本文を保存・再配布していません。
