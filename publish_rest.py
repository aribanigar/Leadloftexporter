import os, sys, json, uuid, argparse, datetime, urllib.request, urllib.parse, urllib.error
# Config comes from the routine environment. The Supabase secret is NEVER hard-coded
# here (GitHub push protection would block it); it is read from the environment, which
# the routine populates. Accepts SUPABASE_SECRET_KEY, SB_SECRET or SUPABASE_SERVICE_KEY.
URL = (os.environ.get("SUPABASE_URL") or "https://cmdnezltteldysoxyjzh.supabase.co").rstrip("/")
KEY = (os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SB_SECRET")
       or os.environ.get("SUPABASE_SERVICE_KEY"))
WS  = os.environ.get("HUB_WORKSPACE") or "1a716353-9472-4c1d-ae89-f95052e8f015"
if not KEY:
    raise SystemExit("No Supabase key in env (SUPABASE_SECRET_KEY / SB_SECRET / SUPABASE_SERVICE_KEY)")
TYPE_MAP = {"email":"html_email","html_email":"html_email","html":"html_email","whatsapp":"whatsapp","wa":"whatsapp","linkedin":"caption","caption":"caption","post":"caption","social":"caption","sms":"sms","text":"sms","outreach":"other","other":"other","dm":"other","cold":"other"}
PLATFORM_MAP = {"html_email":"email","whatsapp":"whatsapp","caption":"linkedin","sms":"sms","other":"outreach"}
def _type(t): return TYPE_MAP.get(str(t).strip().lower(), "other")
def _req(method, path, body=None, prefer=None):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    if prefer: h["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{URL}/rest/v1/{path}", data=data, headers=h, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=60); raw=r.read().decode()
        return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e: return e.code, e.read().decode()
def get(path):
    _, j = _req("GET", path); return j
def folder_id(name):
    rows = get(f"content_businesses?workspace_id=eq.{WS}&slug=eq.{urllib.parse.quote(name)}&select=id")
    if rows: return rows[0]["id"]
    rows = get(f"content_businesses?workspace_id=eq.{WS}&name=eq.{urllib.parse.quote(name.title())}&select=id")
    if rows: return rows[0]["id"]
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(); bid=str(uuid.uuid4())
    st, resp = _req("POST","content_businesses",{"id":bid,"workspace_id":WS,"name":name.title(),"slug":name,"created_at":now,"updated_at":now},prefer="return=minimal")
    if st not in (200,201,204): raise SystemExit(f"create folder failed {st}: {resp}")
    return bid
def title_exists(bid, title):
    rows = get(f"content_assets?workspace_id=eq.{WS}&business_id=eq.{bid}&title=eq.{urllib.parse.quote(title)}&select=id")
    return bool(rows)
def publish(folder_name, items):
    bid = folder_id(folder_name); created=skipped=failed=0; errs=[]
    for it in items:
        title=it["title"]
        if title_exists(bid,title): skipped+=1; continue
        t=_type(it.get("type","other")); now=datetime.datetime.now(datetime.timezone.utc).isoformat()
        row={"id":str(uuid.uuid4()),"workspace_id":WS,"business_id":bid,"title":title,"type":t,"platform":PLATFORM_MAP.get(t,"email"),"content":it.get("body") or it.get("body_html",""),"image_url":it.get("image_url"),"created_at":now,"updated_at":now}
        if t=="html_email": row["subject"]=title.split("] ",1)[-1]
        st,resp=_req("POST","content_assets",row,prefer="return=minimal")
        if st in (200,201,204): created+=1
        else: failed+=1; errs.append(f"{title} -> {st}: {resp}")
    print(f"OK folder='{folder_name}' business_id={bid} created={created} skipped={skipped} failed={failed}")
    for e in errs: print("  FAIL", e)
    return failed==0
if __name__=="__main__":
    ap=argparse.ArgumentParser(); ap.add_argument("--folder",default="hudace"); ap.add_argument("batch"); a=ap.parse_args()
    items=json.load(open(a.batch)); ok=publish(a.folder,items); sys.exit(0 if ok else 1)
