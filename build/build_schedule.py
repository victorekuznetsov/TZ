"""Build interactive WK order history from TOPO PM-06 compact files."""
import hashlib,json,re,subprocess,sys
from datetime import date
from pathlib import Path
SITES={"1100":"Полюс Красноярск","1200":"Полюс Вернинское","1300":"Полюс Алдан","1400":"Полюс Магадан","2400":"Полюс Сухой Лог"}
NUM=("p","a","up","uf","qp","qf")
def hid(*v): return hashlib.sha256(json.dumps(v,ensure_ascii=False).encode()).hexdigest()[:18]
def dt(v):
 try:return date.fromisoformat(v).isoformat() if v else None
 except:return None
def val(d,a,ai,i):
 j=d.get(ai,[])[i] if i<len(d.get(ai,[])) else None
 return d.get(a,[])[j] if isinstance(j,int) and j<len(d.get(a,[])) else ""
def main():
 src,out=map(Path,sys.argv[1:3]); rows={}; sources=[]
 for f in sorted(src.glob("[0-9][0-9][0-9][0-9]_20[0-9][0-9].json")):
  raw=f.read_bytes();d=json.loads(raw);wk=0
  for i in range(d["n"]):
   unit=val(d,"e","ei",i)
   if not re.search(r"WK-?\d",unit,re.I):continue
   wk+=1;order=str(d["o"][i]);work=val(d,"w","wi",i) or "Вид работ не указан";name=val(d,"c","ci",i);ci=d["ci"][i];code=str(d.get("cek",[])[ci] or "") if ci<len(d.get("cek",[])) else ""
   key=(d["s"],str(d["y"]),unit,order,work,code,name);r=rows.get(key)
   if not r:
    od=d.get("od",{}).get(order) or [None,None];start=dt(od[0] if od else None);end=dt(od[1] if len(od)>1 else None);m=re.search(r"WK-?(\d+C?)",unit,re.I)
    r=rows[key]={"id":hid(*key),"orderId":hid(d["s"],unit,order),"unitId":hid(d["s"],unit),"site":d["s"],"year":str(d["y"]),"unit":unit,"model":"WK-"+(m.group(1).upper() if m else "?"),"order":order,"work":work,"code":code,"name":name,"start":start,"end":end,"badDate":bool((od[0] and not start) or (len(od)>1 and od[1] and not end) or (start and end and end<start)),"reason":d.get("orr",{}).get(order,""),"source":f.name,"sourceRows":[],"makers":set(),"centers":set(),"needDates":set(),"approvalDates":set(),**{k:None for k in NUM}}
   r["sourceRows"].append(i+1)
   for k in NUM:
    x=d.get(k,[])[i] if i<len(d.get(k,[])) else None
    if isinstance(x,(int,float)) and not isinstance(x,bool):r[k]=(r[k] or 0)+x
   for field,a,ai in (("makers","mf","mfi"),("centers","wc","wci"),("needDates","nd","ndi"),("approvalDates","ad","adi")):
    x=val(d,a,ai,i)
    if x:r[field].add(x)
  sources.append({"file":f.name,"sha256":hashlib.sha256(raw).hexdigest(),"rows":d["n"],"wkRows":wk})
 data=list(rows.values())
 for r in data:
  for k in ("makers","centers","needDates","approvalDates"):r[k]=sorted(r[k])
  r["hasFact"]=any((r[k] or 0)!=0 for k in ("a","uf","qf"));r["remainingQty"]=max(r["qp"]-r["qf"],0) if r["qp"] is not None and r["qf"] is not None else None
 commit=subprocess.check_output(["git","rev-parse","HEAD"],cwd=src.parent).decode().strip();cols=list(data[0]);sf=[k for k in cols if isinstance(data[0][k],str)];dic={k:sorted({r[k] for r in data}) for k in sf};idx={k:{v:i for i,v in enumerate(dic[k])} for k in sf}
 meta={"sourceRepository":"https://github.com/victorekuznetsov/TOPO","sourceCommit":commit,"sourceFiles":sources,"sites":SITES,"rawRows":sum(s["wkRows"] for s in sources),"lines":len(data),"orders":len({r["orderId"] for r in data}),"units":len({r["unitId"] for r in data}),"years":sorted({r["year"] for r in data}),"completionStatusesAvailable":False,"actualWorkDatesAvailable":False,"dependenciesAvailable":False,"quantityUnitsAvailable":False,"grain":"площадка × год × ЕО × заказ × вид работ × ЕКМТР × компонент"}
 out.mkdir(exist_ok=True);names=[]
 for n,start in enumerate(range(0,len(data),1500)):
  subset=data[start:start+1500];sd={k:sorted({r[k] for r in subset}) for k in sf};si={k:{v:i for i,v in enumerate(sd[k])} for k in sf};payload={"columns":cols,"dictionaries":sd,"rows":[[si[k][r[k]] if k in si else r[k] for k in cols] for r in subset]};name=f"schedule_{n:02d}";names.append(name);raw=json.dumps(payload,ensure_ascii=False,separators=(",",":"),allow_nan=False);(out/(name+".local.js")).write_text('window.__DATA__=window.__DATA__||{};window.__DATA__["'+name+'"]='+raw.replace("</","<\\/")+";\n")
 raw=json.dumps({"meta":meta,"shards":names},ensure_ascii=False,separators=(",",":"),allow_nan=False);(out/"schedule_manifest.local.js").write_text('window.__DATA__=window.__DATA__||{};window.__DATA__["schedule_manifest"]='+raw.replace("</","<\\/")+";\n");print(meta)
if __name__=="__main__":main()
