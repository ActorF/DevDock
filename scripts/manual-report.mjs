const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const inline = value => escape(value).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/&lt;br\s*\/?&gt;/g, '<br>')

export function manualReport(markdown, acceptanceId, version = '0.2.0') {
  if (/\{\{[A-Z_]+\}\}/.test(markdown)) throw new Error('Resolve every manual checklist placeholder before generating the report')
  const lines = markdown.split(/\r?\n/)
  const parts = []
  let inTable = false
  let tableHeader = false
  let inCode = false
  let code = []
  let cases = 0
  const caseIds = new Set()
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) { parts.push(`<pre>${escape(code.join('\n'))}</pre>`); code = [] }
      inCode = !inCode
      continue
    }
    if (inCode) { code.push(line); continue }
    if (line.trim().startsWith('|')) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
      if (cells.every(cell => /^:?-+:?$/.test(cell))) continue
      const id = cells[0].match(/\b[A-Z]{1,3}\d{2,3}\b/)?.[0]
      if ((id && cells.at(-1) === '____') || cells.at(-1) === '结果') cells.pop()
      if (!inTable) { parts.push('<div class="table-wrap"><table><tbody>'); inTable = true; tableHeader = true }
      if (id) {
        if (caseIds.has(id)) throw new Error(`Duplicate manual checklist case: ${id}`)
        caseIds.add(id)
        cases++
        parts.push(`<tr data-case="${id}">${cells.map(cell => `<td>${inline(cell)}</td>`).join('')}<td class="result"><label>人工结果<select aria-label="${id} 验收结果"><option value="pending">待验证</option><option value="pass">通过</option><option value="fail">有问题</option><option value="skip">暂不验证</option></select></label><textarea aria-label="${id} 备注" placeholder="现象、报错或截图文件名" rows="2"></textarea></td></tr>`)
      } else if (tableHeader) parts.push(`<tr>${cells.map(cell => `<th>${inline(cell)}</th>`).join('')}${cells[0] === '编号' && cells[1] === '操作' ? '<th>你的验证结果</th>' : ''}</tr>`)
      else parts.push(`<tr>${cells.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`)
      tableHeader = false
      continue
    }
    if (inTable) { parts.push('</tbody></table></div>'); inTable = false }
    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) { parts.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue }
    if (line.trim()) parts.push(`<p>${inline(line)}</p>`)
  }
  if (inTable) parts.push('</tbody></table></div>')
  if (!cases) throw new Error('Manual checklist must contain test cases with IDs in the first table column')
  return `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DevDock · 人工验收</title>
<style>
:root{color-scheme:light;font:14px/1.7 "Segoe UI","Microsoft YaHei",sans-serif;color:#253044;background:#f1f3f8}*{box-sizing:border-box}body{margin:0}header{position:sticky;top:0;z-index:4;background:#fff;border-bottom:1px solid #dbe1eb;padding:16px 28px;box-shadow:0 3px 12px #23334a08}header .row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header strong{font-size:18px;margin-right:auto;color:#402d73}header small{color:#657286}button,input,select,textarea{font:inherit;border:1px solid #c5ccda;border-radius:6px;padding:7px 10px;background:#fff;color:inherit}button{cursor:pointer}button.primary{background:#6243a5;border-color:#6243a5;color:white}input{min-width:250px}main{max-width:1600px;margin:28px auto;padding:0 28px 70px}h1{font-size:30px;letter-spacing:-.6px}h2{font-size:22px;margin:36px 0 15px;color:#402d73}h3{margin-top:28px}p{max-width:1100px;margin:10px 0}code{font:13px Consolas,monospace;background:#eceaf3;border-radius:4px;padding:2px 5px;overflow-wrap:anywhere}pre{padding:15px;background:#e9edf5;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}.table-wrap{overflow:auto;border:1px solid #d7dce7;border-radius:9px;margin:14px 0;background:#fff}table{border-collapse:collapse;width:100%;min-width:980px}td,th{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #e4e7ee;min-width:90px}th{background:#eaeef6;color:#4b586d;font-size:13px}td:first-child{font-weight:700;color:#6243a5;width:65px;min-width:65px}tr:last-child td{border-bottom:0}.result{width:220px;min-width:220px;background:#fbfcff}.result label{display:block;font-size:12px;color:#657286}.result select{display:block;width:100%;margin:4px 0 8px}.result textarea{width:100%;resize:vertical;font-size:13px}tr[data-state=pass]{box-shadow:inset 4px 0 #2e9465}tr[data-state=fail]{box-shadow:inset 4px 0 #d85757}tr[hidden]{display:none}.notice{padding:12px 16px;background:#e8e2f5;border-radius:8px;color:#49366f}#storage-warning{color:#a13030}footer{color:#6b7587;margin-top:28px}@media print{header{position:static}header button,header input,header select{display:none}main{padding:0}.table-wrap{overflow:visible}table{min-width:0}.result{min-width:130px;width:130px}tr{break-inside:avoid}}
</style>
<header><div class="row"><strong>DevDock / 人工验收台</strong><input id="search" aria-label="搜索验收项目" placeholder="搜索功能、编号或项目…"><select id="filter" aria-label="筛选验收结果"><option value="all">全部项目</option><option value="pending">待验证</option><option value="fail">有问题</option><option value="pass">已通过</option><option value="skip">暂不验证</option></select><button class="primary" id="export">导出验证结果</button><button id="print">打印 / PDF</button></div><small id="progress"></small><small id="storage-warning"></small></header>
<main><div class="notice">这里的结果由你填写，初始全部为“待验证”。填写会保存在当前浏览器；验证后导出结果文件发给我，我可以按编号修复。打开桌面程序请双击验收目录中的启动器。</div>${parts.join('\n')}<footer>本文件可离线使用。结果保存在当前浏览器本地，请用“导出验证结果”保留一份可分享副本。</footer></main>
<script>
const key=${JSON.stringify(`devdock-manual-${acceptanceId}`)};const rows=[...document.querySelectorAll('[data-case]')];let state={};try{state=JSON.parse(localStorage.getItem(key)||'{}')}catch{}
const search=document.querySelector('#search'),filter=document.querySelector('#filter');
function refresh(){const count={pending:0,pass:0,fail:0,skip:0};for(const row of rows){const item=state[row.dataset.case]||{status:'pending',note:''};count[item.status]++;row.dataset.state=item.status;row.hidden=(filter.value!=='all'&&filter.value!==item.status)||!row.textContent.toLowerCase().includes(search.value.toLowerCase())}document.querySelector('#progress').textContent='共 '+rows.length+' 项 · 通过 '+count.pass+' · 有问题 '+count.fail+' · 待验证 '+count.pending+' · 暂不验证 '+count.skip}
function save(){try{localStorage.setItem(key,JSON.stringify(state))}catch{document.querySelector('#storage-warning').textContent=' 自动保存不可用，请及时导出结果。'}refresh()}
for(const row of rows){const id=row.dataset.case;const select=row.querySelector('select'),note=row.querySelector('textarea');const item=state[id]||{status:'pending',note:''};select.value=item.status;note.value=item.note;for(const el of [select,note])el.addEventListener('input',()=>{state[id]={status:select.value,note:note.value};save()})}
search.addEventListener('input',refresh);filter.addEventListener('change',refresh);document.querySelector('#print').onclick=()=>window.print();document.querySelector('#export').onclick=()=>{const data={product:'DevDock',version:${JSON.stringify(version)},acceptanceId:${JSON.stringify(acceptanceId)},exportedAt:new Date().toISOString(),results:rows.map(row=>({id:row.dataset.case,description:row.cells[1]?.textContent.trim(),...(state[row.dataset.case]||{status:'pending',note:''})}))};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='DevDock-人工验证结果.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};refresh();
</script></html>`
}
