import json, urllib.request, itertools, csv, io, sys
B="https://pxweb.stat.si/SiStatData/api/v1/sl/Data/{}.px"
def meta(t): return json.load(urllib.request.urlopen(B.format(t),timeout=120))
def post(t, sel):
    q={"query":[{"code":k,"selection":{"filter":"all" if v=="*" else "item","values":["*"] if v=="*" else v}} for k,v in sel.items()],
       "response":{"format":"json-stat2"}}
    req=urllib.request.Request(B.format(t),data=json.dumps(q).encode(),headers={"Content-Type":"application/json"})
    d=json.load(urllib.request.urlopen(req,timeout=300))
    ids=d["id"]; cats=[sorted(d["dimension"][i]["category"]["index"].items(), key=lambda x:x[1]) for i in ids]
    vals=d["value"]; out=[]
    for n,combo in enumerate(itertools.product(*cats)):
        v=vals[n] if isinstance(vals,list) else vals.get(str(n))
        out.append([c[0] for c in combo]+[v])
    return ids,out
def dump(name,t,sel):
    ids,rows=post(t,sel)
    print("###",name,"|".join(ids+["value"]))
    for r in rows: print("|".join("" if x is None else str(x) for x in r))
    sys.stderr.write(f"{name} {len(rows)}\n")
which=sys.argv[1] if len(sys.argv)>1 else ""
H1=[f"{y}H1" for y in range(2008,2027)]
ages=[str(i) for i in range(0,22)]
if which in ("","pop"):
  for chunk in [H1[:7],H1[7:14],H1[14:]]:
    dump("pop","05C4004S",{"SPOL":["0"],"OBČINE":"*","POLLETJE":chunk,"STAROST":ages})
if which in ("","rest"):
  dump("deaths_reg","05L2016S",{"SPOL":["0"],"STAROST":"*","LETO":"*","STATISTIČNA REGIJA":"*"})
  dump("deaths_mun","05L2020S",{"OBČINE":"*","LETO":[str(y) for y in range(2005,2026)],"MERITVE":["1","2"],"SPOL":["0"]})
  dump("migr_mun","05I2002S",{"OBČINE":"*","LETO":[str(y) for y in range(2005,2026)],"MERITVE":["19","07","16","28"]})
  dump("tenure","0861102S",{"OBČINE":"*","TIP LASTNIŠTVA":"*","LETO":"*","MERITVE":["1"]})
  dump("dwell","0861110S",{"OBČINE":"*","NASELJENOST":"*","VRSTA STAVBE":["0","11","13"],"LETO":"*","MERITVE":["1"]})
  dump("wage","0711344S",{"OBČINE":"*","SPOL":["TOT"],"LETO":[str(y) for y in range(2008,2023)],"PLAČA":["2"],"MERITVE":["1","2"]})
  dump("sel","2640010S",{"MERITVE":["45","50","54","12"],"OBČINE":"*","LETO":"*"})
  dump("proj_nat","05U3021S",{"MERITVE":"*","LETO":[str(y) for y in range(2025,2041)]})
