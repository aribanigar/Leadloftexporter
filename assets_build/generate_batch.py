#!/usr/bin/env python3
"""Generate the Hudace daily batch: 6 emails (Gmail-safe HTML) + WhatsApp,
LinkedIn caption, and outreach per service. Writes batch.json.
Voice: SAP-calm, outcome-first. No emojis, no em dashes, no exclamation, no region names."""
import json, os, datetime, html

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATE = os.environ.get("RUN_DATE") or datetime.date.today().isoformat()
BASE = "https://leadloftexporter.vercel.app/email"
WA   = "https://wa.me/918218929990"
SITE = "https://hudace.com"
IG   = "https://www.instagram.com/hudaceofficial/"
LI   = "https://www.linkedin.com/company/hudace"

SERVICES = [
 {"key":"social","label":"SOCIAL MEDIA","industry":"retail","subject":"Turn attention into demand",
  "hero":"Attention","sub":"A content engine that turns followers into buyers.",
  "deliv":["6 short-form videos / month","12 feed posts / month","8 stories / month",
    "Captions and hashtag sets","Content calendar and scheduling","Community management (comments and DMs)","Monthly performance report"],
  "scope":"For retail, we build a monthly content engine that keeps new arrivals, offers, and best sellers in front of buyers, so foot traffic and online orders stay warm between campaigns.",
  "proof":"We have run always-on social for consumer brands and moved the needle where it counts, saved response time on comments and DMs, and a steady lift in saved and shared posts that pull new buyers in.",
  "hooks":[("Consistency compounds","A fixed monthly cadence keeps your brand in the feed every week, so buyers remember you when they are ready to spend."),
           ("Short-form does the selling","Six videos a month give the algorithm what it rewards and give buyers the format they actually watch."),
           ("Replies close sales","Managed comments and DMs mean questions get answered fast, and fast answers become orders.")],
  "future":"As the account grows we layer in paid amplification and creator collaborations on the same content, so reach scales without starting from zero."},

 {"key":"seo","label":"SEO / AEO / GEO / SRX","industry":"real estate","subject":"Be found before your competitors",
  "hero":"Visibility","sub":"Rank in search and inside AI answers, not just on page two.",
  "deliv":["Technical SEO audit and fixes","Keyword and intent research","On-page optimization (titles, meta, headings, schema)",
    "Content briefs and optimization","Authority and backlink building","Local SEO (profile, citations, maps)",
    "AEO: answer-engine optimization (FAQ, structured answers)","GEO: visibility inside AI-generated answers",
    "SRX: search experience and Core Web Vitals","Monthly ranking and traffic report"],
  "scope":"For real estate and construction, we make your projects, listings, and locations the answer buyers and partners find first, in search and in the AI tools they now ask before they call.",
  "proof":"We have taken sites from invisible to first-page for the terms that bring qualified enquiries, fixed the technical debt that held them back, and earned the local visibility that turns searches into site visits.",
  "hooks":[("Intent over volume","We target the searches that signal a ready buyer, not vanity keywords, so the traffic you gain is traffic that converts."),
           ("AI answers are the new page one","AEO and GEO put you inside the AI-generated answers your buyers read before any website."),
           ("Speed is ranking","SRX and Core Web Vitals work fixes the slow pages that quietly cost you rank and enquiries.")],
  "future":"Once ranking is stable we expand into new project pages and question-led content, so you own more of the search real estate every quarter."},

 {"key":"website","label":"WEBSITE DESIGN","industry":"retail","subject":"A website that sells while you sleep",
  "hero":"Conversion","sub":"A fast, mobile-first site built to turn visitors into leads.",
  "deliv":["Custom multi-page website","Mobile-first responsive build","Booking, lead, and contact forms",
    "CMS to edit content yourself","SEO-ready structure and speed","Analytics and WhatsApp integration",
    "Hosting and domain setup","Launch and handover"],
  "scope":"For retail, we build a storefront-grade site that loads fast on mobile, shows your range clearly, and routes every enquiry straight to WhatsApp, so browsing turns into buying.",
  "proof":"We have replaced slow, dated sites with fast, mobile-first builds that lifted enquiries and gave owners a site they can update themselves, without a developer on call.",
  "hooks":[("Mobile-first is buyer-first","Most of your visitors are on a phone, so we build for the phone first and the desktop second."),
           ("Every page has a job","Clear structure and forms guide visitors to book, message, or buy, instead of leaving them to wander."),
           ("You stay in control","A simple CMS lets your team change prices, offers, and content in minutes, with no invoice attached.")],
  "future":"When you are ready we extend the same site into online payments and a booking or catalogue system, so it grows with the business."},

 {"key":"erp","label":"ERP BUILDING","industry":"real estate","subject":"Run the whole business on one system",
  "hero":"Control","sub":"Custom software that replaces spreadsheets and disconnected tools.",
  "deliv":["Discovery and module blueprint","Custom modules (CRM, inventory, billing, HR, and more)",
    "Role-based access and dashboards","Workflow automations","Integrations (payments, messaging, APIs)",
    "Web and mobile access","Training and documentation","Ongoing support and iterations"],
  "scope":"For real estate and construction, we build one system for leads, inventory of units, billing, and site teams, so nothing lives in a spreadsheet and every stakeholder sees the same numbers.",
  "proof":"We have replaced tangles of spreadsheets and off-the-shelf tools with a single custom system, cut the manual work, and given leaders dashboards that show the real state of the business at a glance.",
  "hooks":[("Built around your process","Off-the-shelf software bends your business to its shape; a custom build bends the software to yours."),
           ("One source of truth","Role-based dashboards mean sales, finance, and operations work from the same live data, not their own copies."),
           ("Automation removes the busywork","Workflows handle the repetitive steps, so your team spends its time on decisions, not data entry.")],
  "future":"The blueprint is modular, so we add inventory, HR, or partner portals as new needs appear, without rebuilding what already works."},

 {"key":"aistudio","label":"AI WORK STUDIO","industry":"retail","subject":"Cinematic ads without a film crew",
  "hero":"Cinema","sub":"Broadcast-grade video, produced with AI in days, not weeks.",
  "deliv":["60-second cinematic film","Three 15-second social cuts","Ten AI-generated stills",
    "Script and concept included","Delivered in seven working days, no film crew"],
  "scope":"For retail, we produce a cinematic hero film and ready-to-post social cuts of your products and store, so your brand looks premium across every channel, without a shoot to organise.",
  "proof":"We have delivered cinematic films and social cuts that gave brands a premium look on a fraction of a traditional production budget, in a fraction of the time.",
  "hooks":[("Premium look, no production","AI production removes the crew, the location, and the wait, and keeps the cinematic result."),
           ("One shoot, many cuts","A single concept becomes a hero film, three social cuts, and ten stills, so one budget feeds every channel."),
           ("Seven days to on-air","A fixed seven-day turnaround means you can plan launches around a date you can trust.")],
  "future":"Once the first film performs we build a library of seasonal and product variations on the same look, so your feed never runs dry."},

 {"key":"schoolos","label":"SCHOOLOS","industry":"schools","subject":"One connected system for your school",
  "hero":"SchoolOS","sub":"Admissions, academics, attendance, fees, and communication on one platform.",
  "deliv":["Admissions: online enquiry to enrollment","Student records: profiles, documents, history",
    "Attendance: daily and period, parent alerts","Fees: invoices, online payments, reminders, receipts",
    "Examinations: marks, grading, report cards","Timetable: classes, teachers, substitutions",
    "Communication: announcements and parent app","Transport: routes, vehicles, live tracking",
    "Library: catalog, issue and return","HR and payroll: staff and salaries","Reports: management dashboards"],
  "scope":"For schools, SchoolOS connects the front office, the classroom, and the parent in one system, so admissions, attendance, fees, and results stop living in separate registers and start working together.",
  "proof":"Schools that move to one connected system spend less time reconciling registers and chasing fees, and give parents the visibility that keeps them engaged and enrolled.",
  "hooks":[("One system, not ten","Admissions, attendance, fees, and exams share one record, so staff stop re-entering the same data."),
           ("Parents stay informed","Attendance alerts, fee reminders, and a parent app keep families close, which keeps retention high."),
           ("Leaders see everything","Management dashboards turn daily operations into numbers you can act on, not guesswork.")],
  "future":"The platform is modular, so you start with admissions and fees and add transport, library, and payroll as you are ready."},
]

INDUSTRY_TITLE = {"retail":"retail","real estate":"real estate and construction","schools":"schools"}
NAME = {"social":"Social Media","seo":"SEO / AEO / GEO / SRX","website":"Website Design",
        "erp":"ERP Building","aistudio":"AI Work Studio","schoolos":"SchoolOS (School ERP)"}

# ---------- Gmail-safe HTML email ----------
STYLE = """<style>
@media only screen and (max-width:600px){
 .ct{width:100%!important} .btn{display:block!important;width:100%!important;margin:0 0 12px 0!important}
 .px{padding-left:22px!important;padding-right:22px!important} .h1{font-size:34px!important;line-height:38px!important}
}
@media (prefers-color-scheme:dark){ body,.bgwrap{background:#05050D!important} }
[data-ogsc] body,[data-ogsc] .bgwrap{background:#05050D!important}
[data-ogsc] .txt{color:#ffffff!important} [data-ogsc] .muted{color:#9A9AAE!important}
</style>"""

def btn_pair(align="left"):
    return f"""<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding:0 12px 0 0">
 <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
 <td class="btn" bgcolor="#1B90FF" style="border-radius:8px" align="center">
 <a href="{WA}" style="display:inline-block;padding:14px 26px;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px">Chat on WhatsApp</a>
 </td></tr></table></td>
<td>
 <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
 <td class="btn" style="border-radius:8px;border:1px solid #2b2b40" align="center">
 <a href="{SITE}" style="display:inline-block;padding:13px 24px;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px">Visit Our Website</a>
 </td></tr></table></td>
</tr></table>"""

def deliv_rows(items):
    r=""
    for it in items:
        r+=f"""<tr><td width="20" valign="top" style="padding:7px 0"><div style="width:8px;height:8px;background:#1B90FF;border-radius:2px;margin-top:6px"></div></td>
<td class="txt" style="padding:6px 0;font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:22px;color:#e9e9f0">{html.escape(it)}</td></tr>"""
    return r

def hooks_rows(hooks):
    r=""
    for i,(t,b) in enumerate(hooks,1):
        r+=f"""<tr><td style="padding:0 0 18px 0">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td width="40" valign="top"><div style="font-family:Montserrat,Arial,sans-serif;font-size:22px;font-weight:700;color:#1B90FF">{i}</div></td>
<td><div class="txt" style="font-family:Montserrat,Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;padding-bottom:4px">{html.escape(t)}</div>
<div class="muted" style="font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:21px;color:#9A9AAE">{html.escape(b)}</div></td>
</tr></table></td></tr>"""
    return r

def build_email(s):
    key=s["key"]; ind=INDUSTRY_TITLE[s["industry"]]
    preheader=f"{s['sub']} Deliverables, scope, and how it converts."
    return f"""<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
{STYLE}
<div style="display:none;max-height:0;overflow:hidden;opacity:0">{html.escape(preheader)}</div>
<table role="presentation" class="bgwrap" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#05050D" style="background:#05050D">
<tr><td align="center" style="padding:0">
<table role="presentation" class="ct" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">

<!-- header -->
<tr><td bgcolor="#05050D" class="px" style="padding:22px 32px">
<img src="{BASE}/logo_white.png" width="128" alt="Hudace" style="display:block;border:0;height:auto"></td></tr>

<!-- hero live text -->
<tr><td bgcolor="#08080f" class="px" style="padding:34px 32px 8px 32px;background:#08080f">
<div style="font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1px;color:#1B90FF;padding-bottom:14px">{s['label']}</div>
<div class="h1 txt" style="font-family:Montserrat,Arial,sans-serif;font-size:44px;line-height:48px;font-weight:700;color:#ffffff;padding-bottom:12px">{html.escape(s['hero'])}</div>
<div class="muted" style="font-family:Montserrat,Arial,sans-serif;font-size:16px;line-height:24px;color:#9A9AAE;padding-bottom:24px">{html.escape(s['sub'])}</div>
{btn_pair()}
</td></tr>
<!-- hero photo -->
<tr><td bgcolor="#08080f" style="padding:24px 0 0 0;background:#08080f;font-size:0">
<img src="{BASE}/photo_{key}.jpg" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>

<!-- deliverables -->
<tr><td bgcolor="#0A0919" class="px" style="padding:34px 32px 10px 32px;background:#0A0919">
<div style="font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1px;color:#1B90FF;padding-bottom:16px">WHAT YOU GET</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">{deliv_rows(s['deliv'])}</table>
</td></tr>

<!-- baked promo card -->
<tr><td bgcolor="#0A0919" style="padding:22px 32px 0 32px;background:#0A0919;font-size:0" class="px">
<img src="{BASE}/card_{key}.jpg" width="536" alt="Hudace {html.escape(s['label'])}" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:10px"></td></tr>

<!-- industry scope -->
<tr><td bgcolor="#0A0919" class="px" style="padding:30px 32px 6px 32px;background:#0A0919">
<div style="font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1px;color:#1B90FF;padding-bottom:12px">IN {ind.upper()}</div>
<div class="txt" style="font-family:Montserrat,Arial,sans-serif;font-size:16px;line-height:25px;color:#e9e9f0">{html.escape(s['scope'])}</div>
</td></tr>

<!-- why it works -->
<tr><td bgcolor="#05050D" class="px" style="padding:32px 32px 14px 32px;background:#05050D">
<div style="font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1px;color:#1B90FF;padding-bottom:20px">WHY IT WORKS</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">{hooks_rows(s['hooks'])}</table>
</td></tr>

<!-- proof + future -->
<tr><td bgcolor="#0A0919" class="px" style="padding:26px 32px;background:#0A0919">
<div class="muted" style="font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:22px;color:#9A9AAE;padding-bottom:12px"><span style="color:#ffffff;font-weight:700">Proof. </span>{html.escape(s['proof'])}</div>
<div class="muted" style="font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:22px;color:#9A9AAE"><span style="color:#ffffff;font-weight:700">What comes next. </span>{html.escape(s['future'])}</div>
</td></tr>

<!-- closing CTA -->
<tr><td bgcolor="#08080f" class="px" style="padding:32px 32px;background:#08080f">
<div class="txt" style="font-family:Montserrat,Arial,sans-serif;font-size:20px;line-height:27px;font-weight:700;color:#ffffff;padding-bottom:18px">Tell us the outcome you want. We will show you the plan to get there.</div>
{btn_pair()}
</td></tr>

<!-- social -->
<tr><td bgcolor="#05050D" align="center" style="padding:26px 32px 8px 32px;background:#05050D">
<a href="{IG}" style="text-decoration:none"><img src="{BASE}/icon_instagram.png" width="26" height="26" alt="Instagram" style="border:0;margin:0 8px"></a>
<a href="{LI}" style="text-decoration:none"><img src="{BASE}/icon_linkedin.png" width="26" height="26" alt="LinkedIn" style="border:0;margin:0 8px"></a>
<a href="{WA}" style="text-decoration:none"><img src="{BASE}/icon_whatsapp.png" width="26" height="26" alt="WhatsApp" style="border:0;margin:0 8px"></a>
</td></tr>

<!-- footer -->
<tr><td bgcolor="#05050D" align="center" style="padding:8px 32px 34px 32px;background:#05050D">
<img src="{BASE}/mark.png" width="34" height="34" alt="Hudace" style="border:0;display:inline-block;padding-bottom:12px"><br>
<div class="muted" style="font-family:Montserrat,Arial,sans-serif;font-size:12px;line-height:19px;color:#9A9AAE">hudace.com &nbsp;&middot;&nbsp; contact@hudace.com &nbsp;&middot;&nbsp; +91 82189 29990</div>
<div style="font-family:Montserrat,Arial,sans-serif;font-size:11px;color:#5b5b70;padding-top:8px">You are receiving this because you enquired with Hudace. <a href="{SITE}" style="color:#5b5b70">Unsubscribe</a></div>
</td></tr>

</table></td></tr></table>"""

# ---------- messaging copy ----------
def whatsapp(s):
    d=s['deliv']; top=", ".join(x.split(" (")[0].split(":")[0] for x in d[:3])
    return (f"Hudace {NAME[s['key']]} for {INDUSTRY_TITLE[s['industry']]}.\n\n"
            f"{s['sub']}\n\nWhat you get: {top}, and more.\n\n"
            f"{s['scope']}\n\nWant the full plan and pricing. Message us here: {WA}")

def linkedin(s):
    lines="\n".join(f"- {x}" for x in s['deliv'][:5])
    return (f"{s['hero']}. {s['sub']}\n\n"
            f"Hudace {NAME[s['key']]}, built for {INDUSTRY_TITLE[s['industry']]}:\n{lines}\n\n"
            f"{s['scope']}\n\n"
            f"The method is simple. Lead with the outcome, then build the system that delivers it.\n\n"
            f"Talk to us: {WA}  |  {SITE}\ncontact@hudace.com  |  +91 82189 29990")

def outreach(s):
    d=", ".join(x.split(" (")[0].split(":")[0] for x in s['deliv'][:4])
    return (f"Subject: {s['subject']}\n\n"
            f"Hello,\n\n"
            f"We work with teams in {INDUSTRY_TITLE[s['industry']]} on one outcome: {s['sub'].lower()}\n\n"
            f"With Hudace {NAME[s['key']]} you get {d}, and more. {s['scope']}\n\n"
            f"If this is a priority this quarter, I can share a short plan and pricing built for your business. "
            f"Would a brief call this week work.\n\n"
            f"Hudace\n{SITE}  |  {WA}\ncontact@hudace.com  |  +91 82189 29990")

# ---------- assemble batch ----------
items=[]
for s in SERVICES:
    name=NAME[s['key']] if s['key']!="schoolos" else "SchoolOS (School ERP)"
    card=f"{BASE}/card_{s['key']}.jpg"
    items.append({"title":f"[{DATE}] {name}","type":"html_email","subject":s['subject'],
                  "body":build_email(s),"image_url":card})
    items.append({"title":f"[{DATE}] {name} - WhatsApp","type":"whatsapp",
                  "body":whatsapp(s),"image_url":card})
    items.append({"title":f"[{DATE}] {name} - LinkedIn","type":"caption",
                  "body":linkedin(s),"image_url":card})
    items.append({"title":f"[{DATE}] {name} - Outreach","type":"other",
                  "body":outreach(s),"image_url":card})

with open(os.path.join(ROOT,"batch.json"),"w") as f:
    json.dump(items,f,indent=2,ensure_ascii=False)
# save one email for visual check
with open(os.path.join(ROOT,"assets_build","preview_social.html"),"w") as f:
    f.write("<!doctype html><html><head><meta charset=utf-8></head><body style='margin:0'>"+build_email(SERVICES[0])+"</body></html>")
print(f"batch.json: {len(items)} items ({len(SERVICES)} services x 4), date {DATE}")
