// Regenerate the compact name catalogue after replacing either supplied stop CSV.
const fs=require('node:fs');
const path=require('node:path');
function csv(text){
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(!quoted&&(c===','||c==='\n')){row.push(field.replace(/\r$/,''));field='';if(c==='\n'){rows.push(row);row=[];}}
    else field+=c;
  }
  if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}return rows;
}
const root=path.resolve(__dirname,'..'),names={};
for(const file of ['stops_bus.csv','stops_train.csv']){
  const [header,...rows]=csv(fs.readFileSync(path.join(root,file),'utf8').replace(/^\uFEFF/,''));
  const fields=header.map(s=>s.toLowerCase().replace(/[^a-z]/g,'')),code=fields.indexOf('stopcode'),name=fields.indexOf('stopname');
  if(code<0||name<0)throw Error(`Missing stop name/code columns in ${file}`);
  for(const row of rows)if(row[code]&&row[name])names[row[code]]=row[name];
}
fs.writeFileSync(path.join(root,'performance/stop-names.json'),JSON.stringify(names));
console.log(`Wrote ${Object.keys(names).length} stop names`);
