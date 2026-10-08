const { dateAt }=require('./feed.cjs');
const {searchOptions}=require('./search.cjs');
function options(url) {
  const today=dateAt(Date.now()/1000), q=url.searchParams;
  const from=q.get('from')||today,to=q.get('to')||today;
  const valid=date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10)===date;
  if (!valid(from)||!valid(to)||from>to||Date.parse(to)-Date.parse(from)>366*86400000) throw Error('Choose a date range of at most 366 days');
  const routeId=Number(q.get('route')||0),early=Number(q.get('early')??60),late=Number(q.get('late')??300),kind=q.get('kind')||'arrival';
  if (!Number.isInteger(routeId)||routeId<0||!['arrival','departure'].includes(kind)||!Number.isFinite(early)||!Number.isFinite(late)||early<0||late<0||early>3600||late>3600) throw Error('Invalid report filters');
  return {from,to,routeId,early,late,kind,...searchOptions(q)};
}
function csvCell(value) {
  let text=String(value??''); if (/^[=+\-@\t\r]/.test(text)) text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
module.exports={options,csvCell};
