// コード.js
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('生物マスターDB 自動登録システム')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function processJellyfish(speciesName) {
  try {
    const props = PropertiesService.getScriptProperties();
    const notionApiKey = props.getProperty('NOTION_API_KEY');
    const notionDbId = props.getProperty('NOTION_DATABASE_ID');

    if (!notionApiKey || !notionDbId) {
      throw new Error('GASのスクリプトプロパティに NOTION_API_KEY または NOTION_DATABASE_ID が設定されていません。');
    }

    let inputStr = speciesName.trim();
    let isUrlInput = inputStr.startsWith("http");
    let displayTitle = isUrlInput ? "名称未取得" : inputStr;

    // --- 1. 黒潮生物図鑑 スクレイピング ---
    let kuroUrl = isUrlInput ? inputStr : `https://kuroshio.or.jp/creature/${encodeURIComponent(inputStr)}/`;
    let kuroshioName = "";
    let scientificName = "";
    let description = "未記載（黒潮生物図鑑に該当データがありません）";
    let isKuroshioFound = false;

    try {
      const kRes = UrlFetchApp.fetch(kuroUrl, { muteHttpExceptions: true });
      if (kRes.getResponseCode() === 200) {
        const html = kRes.getContentText("UTF-8");
        // <div id="single-creature"> 以降の全体を対象とする（articleタグの有無に依存させない）
        const divMatch = html.match(/id=["']single-creature["'][^>]*>(.*)/is) || html.match(/class=["'][^"']*single-creature[^"']*["'][^>]*>(.*)/is);
        if (divMatch) {
          const content = divMatch[1];
          const h3Match = content.match(/<h3[^>]*>(.*?)<\/h3>/is);
          const h4Match = content.match(/<h4[^>]*>(.*?)<\/h4>/is);

          // 解説は article 内の p を優先し、なければ単純に最初の p を取る
          const articleMatch = content.match(/<article[^>]*>(.*?)<\/article>/is);
          let pMatch = null;
          if (articleMatch) {
            pMatch = articleMatch[1].match(/<p[^>]*>(.*?)<\/p>/is);
          }
          if (!pMatch) {
            pMatch = content.match(/<p[^>]*>(.*?)<\/p>/is);
          }

          if (h3Match) {
            kuroshioName = h3Match[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
            isKuroshioFound = true;
          }
          if (h4Match) {
            // 学名は最初の2単語を抽出（イタリック体や不要な空白・&nbsp;を除去）
            const rawSciWords = h4Match[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim().split(/\s+/);
            if (rawSciWords.length >= 2) {
              scientificName = rawSciWords[0] + " " + rawSciWords[1];
            } else if (rawSciWords.length === 1) {
              scientificName = rawSciWords[0];
            }
          }
          if (pMatch) {
            const extractedDesc = pMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
            if (extractedDesc) description = extractedDesc;
          }
        }
      }
    } catch (e) {
      // ログやエラーで落とさない
    }

    // 変数と初期階層ツリー
    let wormsUrl = "なし";
    let bismalUrl = "なし";
    let origPaperName = "原著論文は見つかりませんでした";
    let origPaperUrl = "なし";
    let aphiaId = null;

    let taxTree = {
      Kingdom: { sci: "-", ja: "-" },
      Phylum: { sci: "-", ja: "-" },
      Subphylum: { sci: "-", ja: "-" },
      Class: { sci: "-", ja: "-" },
      Subclass: { sci: "-", ja: "-" },
      Order: { sci: "-", ja: "-" },
      Suborder: { sci: "-", ja: "-" },
      Family: { sci: "-", ja: "-" },
      Genus: { sci: "-", ja: "-" },
      Species: { sci: "-", ja: "-" }
    };

    if (isKuroshioFound) {
      if (isUrlInput && kuroshioName) {
        displayTitle = kuroshioName;
      }
    } else {
      // 該当なしの場合は検索結果へのリンクにフォールバック（直接URL入力の場合はそのまま）
      if (!isUrlInput) kuroUrl = `https://kuroshio.or.jp/?s=${encodeURIComponent(inputStr)}`;
    }

    // 学名が図鑑から取得できなかった場合、入力文字列が学名である可能性を考慮してWoRMS APIの検索キーに用いる
    let searchSciName = scientificName || inputStr;
    if (scientificName && Object.keys(taxTree).length > 0) {
      taxTree.Species.sci = scientificName;
    }

    // WoRMS検索は常に実行を試みる（検索キー: searchSciName）
    // （元のインデント維持のため { } で囲む）
    {
      // --- 2. WoRMS API & スクレイピング ---
      console.log(`【WoRMS】検索開始: 生物種="${displayTitle}", 対象学名="${searchSciName}"`);
      try {
        let wApiUrl = `https://www.marinespecies.org/rest/AphiaIDByName/${encodeURIComponent(searchSciName)}`;
        let wApiRes = UrlFetchApp.fetch(wApiUrl, { muteHttpExceptions: true });
        console.log(`【WoRMS API】レスポンスコード: ${wApiRes.getResponseCode()}`);
        if (wApiRes.getResponseCode() === 200 || wApiRes.getResponseCode() === 206) {
          const resText = wApiRes.getContentText().trim();
          console.log(`【WoRMS API】レスポンス内容: ${resText}`);
          if (/^\-?\d+$/.test(resText)) {
            aphiaId = resText;
            console.log(`【WoRMS API】AphiaIDの取得成功: ${aphiaId}`);
          } else {
            console.log(`【WoRMS API】AphiaIDの形式が不正です`);
          }
        } else {
          console.log(`【WoRMS API】エラーレスポンス本文: ${wApiRes.getContentText()}`);
        }
      } catch (e) {
        console.error(`【WoRMS API】例外エラー: ${e.message}`);
      }

      if (aphiaId) {
        wormsUrl = `https://www.marinespecies.org/aphia.php?p=taxdetails&id=${aphiaId}`;
        console.log(`【WoRMS Html】個別ページ取得開始: ${wormsUrl}`);
        try {
          let wHtmlRes = UrlFetchApp.fetch(wormsUrl, { muteHttpExceptions: true });
          console.log(`【WoRMS Html】レスポンスコード: ${wHtmlRes.getResponseCode()}`);
          if (wHtmlRes.getResponseCode() === 200) {
            let wHtml = wHtmlRes.getContentText();

            // HTMLの各セクションを indexOf で切り出して安全に抽出（divのネスト回避）

            // 1. 系統情報 (<div/ol id="Classification">)
            let classStart = wHtml.indexOf('="Classification"');
            if (classStart !== -1) {
              console.log("【WoRMS Html】Classification要素を発見");
              let classChunk = wHtml.substring(classStart, classStart + 3000);
              let olMatch = classChunk.match(/<ol[^>]*>(.*?)<\/ol>/is);
              if (olMatch) {
                let liMatches = olMatch[1].match(/<li[^>]*>([\s\S]*?)<\/li>/ig);
                if (liMatches) {
                  for (let li of liMatches) {
                    // HTMLタグ除去後、"学名 (Rank)" の形式になる
                    let text = li.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/ig, ' ').replace(/\s+/g, ' ').trim();
                    let match = text.match(/^(.*?)\s+\(([^)]+)\)$/);
                    if (match) {
                      let sci = match[1].trim();
                      let rank = match[2].trim(); // Phylum, Class, Order...
                      if (taxTree[rank]) {
                        taxTree[rank].sci = sci;
                        console.log(`【WoRMS Html】系統階層抽出成功 - ${rank}: ${sci}`);
                      }
                    }
                  }
                }
              }
            } else {
              console.log("【WoRMS Html】Classification要素が見つかりません。");
            }

            // 2. 原著論文 (id="OriginalDescription")
            let odStart = wHtml.indexOf('id="OriginalDescription"');
            if (odStart !== -1) {
              console.log("【WoRMS Html】OriginalDescription要素を発見");
              let odChunk = wHtml.substring(odStart, odStart + 3000);

              // 論文タイトル等を取り出す (correctHTML クラスのspanに記述されていることが多い)
              let paperMatch = odChunk.match(/<span class=["']correctHTML["']>([\s\S]*?)<\/span>/i);
              if (paperMatch) {
                origPaperName = paperMatch[1].replace(/<[^>]+>/g, '').trim();
              }

              // リンクを取り出す（sourceget 等、taxdetails以外で有用そうなURLを探す）
              let linksMatches = odChunk.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/ig);
              if (linksMatches) {
                for (let btn of linksMatches) {
                  let hrefMatch = btn.match(/href=["']([^"']+)["']/i);
                  if (hrefMatch && hrefMatch[1].indexOf('aphia.php?p=taxdetails') === -1 && hrefMatch[1].indexOf('p=sourcedetails') === -1) {
                    let url = hrefMatch[1];
                    origPaperUrl = url;
                    if (!origPaperUrl.startsWith("http")) origPaperUrl = "https://www.marinespecies.org/" + origPaperUrl.replace(/^\//, '');
                    // correctHTMLが存在しなかった場合のフォールバック
                    if (origPaperName === "原著論文は見つかりませんでした") {
                      origPaperName = btn.replace(/<[^>]+>/g, '').trim() || url;
                    }
                    console.log(`【WoRMS Html】原著論文抽出成功 - ${origPaperName} / ${origPaperUrl}`);
                    break; // 最初の有効なリンクを採用
                  }
                }
              }
            } else {
              console.log("【WoRMS Html】OriginalDescription要素が見つかりません。");
            }

            // 3. BISMaLリンク (id="links")
            let linksStart = wHtml.indexOf('id="links"');
            if (linksStart !== -1) {
              console.log("【WoRMS Html】Linksボックスを発見");
              let linksChunk = wHtml.substring(linksStart, linksStart + 3000);
              let bismalLinkMatch = linksChunk.match(/href=["'](https?:\/\/[^\/]*godac\.jamstec\.go\.jp\/bismal[^"']+)["']/i);
              if (bismalLinkMatch) {
                bismalUrl = bismalLinkMatch[1];
                console.log(`【WoRMS Html】BISMaLリンク抽出成功 - URL: ${bismalUrl}`);
              }
            } else {
              console.log("【WoRMS Html】Links要素が見つかりません。");
            }
          }
        } catch (e) {
          console.error(`【WoRMS Html】例外エラー: ${e.message}`);
        }
      } else {
        console.log(`【WoRMS】AphiaIDが存在しないため、個別ページへのアクセスと抽出処理を中止します。`);
      }

      // --- 3. BISMaL スクレイピング ---
      if (bismalUrl !== "なし") {
        try {
          let bRes = UrlFetchApp.fetch(bismalUrl, { muteHttpExceptions: true });
          if (bRes.getResponseCode() === 200) {
            let bHtml = bRes.getContentText();
            // 新しい BISMaL 和名抽出ロジック: 学名をキーにして正しい<a>タグを特定する
            let aTags = bHtml.match(/<a[^>]*>([\s\S]*?)<\/a>/ig);
            if (aTags) {
              for (let rank of Object.keys(taxTree)) {
                let sci = taxTree[rank].sci;
                if (sci === "-") continue;
                
                for (let aTag of aTags) {
                  let spans = aTag.match(/<span[^>]*>([\s\S]*?)<\/span>/ig);
                  if (spans) {
                    let texts = spans.map(s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/ig, '').trim()).filter(t => t.length > 0);
                    // 完全一致を優先して検索
                    let hasSci = texts.some(t => t.toLowerCase() === sci.toLowerCase());
                    if (hasSci) {
                      let jaName = texts.find(t => /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(t));
                      if (jaName) {
                        taxTree[rank].ja = jaName;
                        break;
                      }
                    }
                  }
                }
                // フォールバック（span分割がない場合）
                if (taxTree[rank].ja === "-") {
                  for (let aTag of aTags) {
                    let rawText = aTag.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/ig, ' ').replace(/\s+/g, ' ').trim();
                    if (rawText.toLowerCase().startsWith(sci.toLowerCase() + " ")) {
                       let jaParts = rawText.substring(sci.length).match(/([\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+)/);
                       if (jaParts) {
                          taxTree[rank].ja = jaParts[1];
                          break;
                       }
                    }
                  }
                }
              }
            }
          }
        } catch (e) { }
      }
    }

    let taxListText = "";
    const rankTitles = {
      Kingdom: "界",
      Phylum: "門",
      Subphylum: "亜門",
      Class: "綱",
      Subclass: "亜綱",
      Order: "目",
      Suborder: "亜目",
      Family: "科",
      Genus: "属",
      Species: "種"
    };
    for (let r of Object.keys(rankTitles)) {
       if (taxTree[r] && taxTree[r].sci !== "-") {
          let jaStr = taxTree[r].ja !== "-" ? ` (${taxTree[r].ja})` : "";
          taxListText += `- ${rankTitles[r]}: ${taxTree[r].sci}${jaStr}\n`;
       } else if (["Phylum", "Class", "Order", "Family", "Genus", "Species"].includes(r)) {
          // 主要な階級は空でも出力する（元の仕様維持）
          taxListText += `- ${rankTitles[r]}: -\n`;
       }
    }

    // --- 4. Markdown 構築と Notion API 呼び出し ---
    // taxTree.Species.sciが情報更新されていればそれを優先。なければ scientificName、もしくはWoRMSが弾かなかった searchSciName
    let finalSciName = taxTree.Species.sci !== "-" ? taxTree.Species.sci : (scientificName || "学名未記載");
    let markdown = `# ${displayTitle}・*${finalSciName}*

## 参考リンク
- [黒潮生物図鑑](${kuroUrl})
- [WoRMS](${wormsUrl})
- [BISMaL](${bismalUrl})

## WoRMS・BISMaLによる系統情報
${taxListText.trim()}

## 原著論文 (WoRMSより)
${origPaperUrl !== "なし" ? `- [${origPaperName}](${origPaperUrl})` : "（該当なし）"}

## 黒潮Web生物図鑑の解説
${description}

## Geminiの簡易レポート作成用プロンプト`;

    const blocks = parseMarkdownToNotionBlocks(markdown);

    // プロンプトテンプレート用固定テキスト（Codeブロックとして末尾に追加）
    const promptText = `${displayTitle} について、
Notionに張り付けるように以下のテンプレートを基にまとめてください
まとめた内容の根拠となる論文はdoiを載せてください
Markdownのコードユニットとして出力して下さい
=======================================================
## 系統分類と学名の読み方
[生息環境や、分類上の特筆すべき簡単な解説を1〜2文で記述]

| 階級 | 学名 (読み方) | 和名 |
| --- | --- | --- |
| **界** | Animalia | 動物界 |
| **門** | Cnidaria | 刺胞動物門 |
| **亜門** | Medusozoa | クラゲ亜門 |
| **綱** | [綱の学名] ([読み方]) | [綱の和名] |
| **亜綱** | [亜綱の学名] ([読み方]) | [亜綱の和名] |
| **目** | [目の学名] ([読み方]) | [目の和名] |
| **科** | [科の学名] ([読み方]) | [科の和名] |
| **属** | *[属の学名]* ([読み方]) | [属の和名] |
| **種** | ***[種の学名]*** ([読み方]) | **[種の和名]** |
| **異名** | *[シノニムがある場合は記載]* ([読み方]) | [シノニム等の備考] |

---
## 学名・和名の由来と分類の背景
- **属名 *[属の学名]* ([命名者, 年])**
[属名の語源や由来となった特徴など]
- **種小名 *[種の学名]* ([命名者, 年])**
[種小名の語源や由来となった特徴、発見地など]
- **和名の由来 / シノニムの背景 (該当する場合)**
[和名の由来や、よく使われるシノニムについての歴史的背景、水族館等での呼称など]

---
## 形態分類のための特徴
[傘径のサイズ感など、全体的な特徴を1文で記載]。以下の特徴が分類の鍵となる。
1. **[特徴1: 例 傘の形状と縁膜]**
[詳細な解説]
2. **[特徴2: 例 触手の数と配置]**
[詳細な解説]
3. **[特徴3: 例 放射管と生殖巣]**
[詳細な解説]
4. **近似種との識別**
[混同されやすい近縁種との明確な識別ポイントを記載]

---
## 行動・拍動の特徴 (Behavior & Pulsation)
[遊泳時の拍動リズム、休息時の姿勢、光走性、その他の特異な行動パターンなど、生態的・動的な特徴を記載]

---
## 原著論文 (Primary Literature)
- **有効学名の原記載論文**
    - **著者:** [著者名] ([発行年])
    - **論文名:** [論文タイトル]
    - **掲載誌:** *[雑誌名]*, [巻(号)], [ページ].
    - **備考:** [特記事項があれば記載]

---
## 研究・解析メモ
- [画像認識モデルの適用テスト結果、採取記録、飼育メモなどを自由に記載]`;

    let promptChunks = [];
    let currentIndex = 0;
    while (currentIndex < promptText.length) {
      promptChunks.push({
        type: 'text',
        text: { content: promptText.substring(currentIndex, currentIndex + 2000) }
      });
      currentIndex += 2000;
    }

    blocks.push({
      "object": "block", "type": "code",
      "code": { "rich_text": promptChunks, "language": "plain text" }
    });

    // Notion APIへPOST
    const notionUrl = 'https://api.notion.com/v1/pages';
    const notionPayload = {
      parent: { database_id: notionDbId },
      properties: {
        "種名（和名）": {
          title: [{ text: { content: displayTitle } }]
        }
      },
      children: blocks
    };

    const notionOptions = {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${notionApiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(notionPayload),
      muteHttpExceptions: true
    };

    const notionRes = UrlFetchApp.fetch(notionUrl, notionOptions);
    const notionJson = JSON.parse(notionRes.getContentText());

    if (notionRes.getResponseCode() !== 200) {
      // データベースの設定間違いやプロパティ名エラー時はこちら
      throw new Error(`Notion API エラー: ${notionJson.message || notionRes.getContentText()}`);
    }

    return { success: true, url: notionJson.url };

  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// ==========================================
// カスタム Markdown -> Notion Block パーサー
// ==========================================
function parseMarkdownToNotionBlocks(mdText) {
  let text = mdText.replace(/^```(markdown)?\n?/i, '').replace(/```\n?$/i, '');
  const lines = text.split('\n');
  const blocks = [];

  let i = 0;
  while (i < lines.length) {
    let line = lines[i];
    if (line === undefined) break;

    // --- 水平線 ---
    if (/^---$/.test(line.trim())) {
      blocks.push({ object: "block", type: "divider", divider: {} });
      i++;
      continue;
    }

    // --- 見出し ---
    let hMatch = line.match(/^(#{1,3})\s+(.*)/);
    if (hMatch) {
      const level = hMatch[1].length;
      const type = `heading_${level}`;
      blocks.push({
        object: "block",
        type: type,
        [type]: { rich_text: parseRichText(hMatch[2]) }
      });
      i++;
      continue;
    }

    // --- 箇条書き ---
    let ulMatch = line.match(/^-\s+(.*)/);
    if (ulMatch) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        "bulleted_list_item": { rich_text: parseRichText(ulMatch[1]) }
      });
      i++;
      continue;
    }

    // --- 番号付きリスト ---
    let olMatch = line.match(/^\d+\.\s+(.*)/);
    if (olMatch) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        "numbered_list_item": { rich_text: parseRichText(olMatch[1]) }
      });
      i++;
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    // --- 段落 (Paragraph) ---
    // 見出し等の予約文字が来るまでを1段落とする
    let pLines = [];
    while (i < lines.length) {
      let curr = lines[i];
      if (curr.trim() === '' || /^#{1,3}\s/.test(curr) || /^-\s/.test(curr) || /^\d+\.\s/.test(curr) || /^---$/.test(curr.trim())) {
        break;
      }
      pLines.push(curr);
      i++;
    }

    if (pLines.length > 0) {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: parseRichText(pLines.join('\n')) }
      });
    }
  }
  return blocks;
}

// ------------------------------------------
// 再帰的トークナイザー: [リンク], **太字**, *斜体* を抽出
// ------------------------------------------
function tokenizeRichText(text, defaultAnnotations) {
  let result = [];
  let i = 0;
  while (i < text.length) {
    // リンク記法: [テキスト](URL)
    let linkMatch = text.substring(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
    // 太字: **テキスト**
    let boldMatch = text.substring(i).match(/^\*\*([\s\S]+?)\*\*/);
    // 斜体: *テキスト*
    let italicMatch = text.substring(i).match(/^\*([\s\S]+?)\*/);

    if (linkMatch) {
      result.push({
        content: linkMatch[1],
        bold: defaultAnnotations.bold,
        italic: defaultAnnotations.italic,
        link: linkMatch[2]
      });
      i += linkMatch[0].length;
    } else if (boldMatch) {
      // ネストされた装飾（太字の中の斜体など）に対応するため再帰呼び出し
      let inner = tokenizeRichText(boldMatch[1], { bold: true, italic: defaultAnnotations.italic });
      result.push(...inner);
      i += boldMatch[0].length;
    } else if (italicMatch) {
      let inner = tokenizeRichText(italicMatch[1], { bold: defaultAnnotations.bold, italic: true });
      result.push(...inner);
      i += italicMatch[0].length;
    } else {
      // 次の特殊文字 "[" or "*" まで文字列を進める
      let nextSpecial = text.substring(i).search(/(\[|\*)/);
      if (nextSpecial === 0) {
        // 解析不能な単独の *, [ は文字列として扱う
        result.push({ content: text[i], bold: defaultAnnotations.bold, italic: defaultAnnotations.italic, link: null });
        i++;
      } else if (nextSpecial > 0) {
        result.push({ content: text.substring(i, i + nextSpecial), bold: defaultAnnotations.bold, italic: defaultAnnotations.italic, link: null });
        i += nextSpecial;
      } else {
        result.push({ content: text.substring(i), bold: defaultAnnotations.bold, italic: defaultAnnotations.italic, link: null });
        break;
      }
    }
  }
  return result;
}

function parseRichText(text) {
  if (!text) return [];
  // Tokenize & Parse
  let tokens = tokenizeRichText(text, { bold: false, italic: false });

  // Notionの仕様（rich_text配列の1要素は最大2000文字の制限）に適合させる
  return tokens.map(t => {
    let c = t.content;
    if (c.length > 2000) c = c.substring(0, 2000);
    let rt = { type: "text", text: { content: c } };
    if (t.link && t.link.startsWith("http")) { // URLの簡易バリデート
      rt.text.link = { url: t.link };
    }
    if (t.bold || t.italic) {
      rt.annotations = {};
      if (t.bold) rt.annotations.bold = true;
      if (t.italic) rt.annotations.italic = true;
    }
    return rt;
  });
}
