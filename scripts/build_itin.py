#!/usr/bin/env python3
"""
build_itin.py - daily content generator for viakashmiritinerary.in (the B2B itinerary
builder). Pure B2B: speaks to travel agents / tour operators about the problems the tool
solves vs Word/Excel and expensive complex builders. Destination-agnostic / all-India.

ORGANISED BY MARKET. Each day produces FOUR sets, one per market:
  india    - any Indian state out of Kashmir (rotates destination + hook by date)
  kashmir  - dedicated to Kashmir travel agents (local hook, tool stays all-India)
  saudi    - travel agents in Saudi Arabia  (bilingual EN + Arabic)
  dubai    - travel agents in Dubai/UAE      (bilingual EN + Arabic)

Each set: email.html  whatsapp.txt  linkedin.txt  meta.json
          ->  content/via-kashmir-itinerary/<date>/<market>/ .
The card, AMP and .eml are produced by their own scripts (mirrors the ViaKashmir engine):
  make_itin_cards.py  -> img/whatsapp.jpg     build_itin_amp.py -> email.amp.html
  build_itin_eml.py   -> email.eml

Images use the proven wsrv pattern (wrap the committed repo file). Photos come ONLY from
the committed pool (Pixabay, watermark-free). --preview swaps wsrv->repo for local paths.

Usage:
  python3 scripts/build_itin.py --date 2026-06-15 --all
  python3 scripts/build_itin.py --date 2026-06-15 --market kashmir [--preview]
"""
import argparse, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POOL = ROOT / "content" / "via-kashmir-itinerary" / "_assets" / "photos"
RAW = "raw.githubusercontent.com/aribanigar/Leadloftexporter/main/content/via-kashmir-itinerary/_assets/photos"

LOGO = "https://wsrv.nl/?url=viakashmir.in/logo-colour.svg&amp;w=400&amp;output=png"
SIGNUP = "https://viakashmiritinerary.in/signup"
WA = "https://wa.me/919186051499?text=Hi%20ViaKashmir%2C%20I%27d%20like%20to%20try%20the%20itinerary%20builder"
CONTACT = "contact@viakashmir.in &nbsp;&nbsp;|&nbsp;&nbsp; +91 918 605 1499"

def img(photo, preview):
    if preview:
        return (POOL / f"{photo}.jpg").resolve().as_uri()
    return f"https://wsrv.nl/?url={RAW}/{photo}.jpg&amp;w=1200&amp;output=jpg&amp;q=82"

# ---- shared blocks (stable shell) -------------------------------------------
BEFORE = ["Open a blank Word or Excel file", "Retype the same day plan again",
          "Fight tables, spacing and fonts", "Export, attach, hope it opens"]
AFTER = ["Pick the days and destinations", "The day-by-day plan writes itself",
         "Your agency name and branding, auto", "Send a clean link or PDF"]
FEATURE_TITLE = "Built for every trip you sell"
FEATURE_BODY = ("Kashmir, Kerala, Rajasthan, Goa, the hills - one builder for every "
                "destination on your sheet. Not tied to any single place.")
CTA_PRE = "Simple to start. Works for every destination."
CTA_HEAD = 'Stop formatting.<br/><span style="color:#9dd3aa;">Start sending.</span>'
CTA_BODY = ("Build a client-ready itinerary in about two minutes, branded as your agency, "
            "and get back to selling the trip.")
PROOF = [("Two minutes", "A full-day plan in about two minutes, not twenty."),
         ("Looks like you", "Every page carries your agency name and branding."),
         ("No learning curve", "No training, no setup project. Open it and build.")]

# ---- hook library used by the India market (rotates daily) ------------------
HOOKS = {
 "word": dict(
   subject="Still building client itineraries in Word",
   head='Still building trips in<br/><span style="color:#9dd3aa;">Word and Excel.</span>',
   body=("Every quote you format by hand and every table you re-align is time your client "
         "spends waiting. Type the days; the builder writes the itinerary for you."),
   accent="The longer your quote takes, the more time your client has to ask someone else.",
   upre="Your next enquiry is waiting", uhead="Reply with a plan,<br/>not a maybe.",
   wa=("Bhai abhi bhi Word/Excel me itinerary bana rahe ho? Din type karo, ViaKashmir "
       "Itinerary khud poora plan bana deta hai - 2 min me ready, aapki branding ke saath. "
       "Dekho: viakashmiritinerary.in/signup"),
   li=("Most agents still build client itineraries in Word. Every quote retyped by hand is "
       "time the client spends shopping around. ViaKashmir Itinerary turns a few inputs into "
       "a branded, client-ready plan in about two minutes. viakashmiritinerary.in/signup")),
 "complex": dict(
   subject="You do not need a complex itinerary builder",
   head='You don\'t need a<br/><span style="color:#9dd3aa;">complex builder.</span>',
   body=("The heavy tools cost more and make you sit through setup and training before you "
         "send a single quote. This one you open and use. Same day, real itineraries."),
   accent="A tool only helps if you actually use it. Simple wins the booking.",
   upre="No setup project", uhead="Open it today.<br/>Send a quote today.",
   wa=("Mehenga aur complicated builder lene ki zarurat nahi. ViaKashmir Itinerary simple "
       "hai - aaj open karo, aaj client ko quote bhejo. Try: viakashmiritinerary.in/signup"),
   li=("Expensive itinerary platforms ask you to sit through onboarding before you send a "
       "single quote. ViaKashmir Itinerary is built to open and use - real client itineraries "
       "the same day. viakashmiritinerary.in/signup")),
 "speed": dict(
   subject="Twenty minutes per itinerary, now two",
   head='Twenty minutes per plan.<br/><span style="color:#9dd3aa;">Now two.</span>',
   body=("A custom day-by-day itinerary by hand takes fifteen to twenty minutes you do not "
         "have during a busy enquiry. Enter the trip; get a finished plan in about two."),
   accent="The agent who replies first usually wins the booking. Reply first.",
   upre="More enquiries, same day", uhead="Quote faster.<br/>Book more.",
   wa=("Ek itinerary haath se = 15-20 min. ViaKashmir Itinerary se = ~2 min. Jo agent pehle "
       "reply karta hai, wahi booking leta hai. viakashmiritinerary.in/signup"),
   li=("A custom itinerary by hand eats 15-20 minutes during a busy enquiry. With ViaKashmir "
       "Itinerary it is about two - so you reply first, and the agent who replies first usually "
       "wins the booking. viakashmiritinerary.in/signup")),
 "professional": dict(
   subject="Send a quote that looks like your brand",
   head='Send a quote that looks<br/><span style="color:#9dd3aa;">like your brand.</span>',
   body=("A clean, branded itinerary tells the client you are organised before the trip even "
         "starts. Your name, your look, every page - without designing anything yourself."),
   accent="Clients trust the agent whose quote looks the part. Look the part.",
   upre="First impression, sorted", uhead="Look organised<br/>before day one.",
   wa=("Client ko aisa itinerary bhejo jo aapke brand jaisa dikhe - naam, logo, clean PDF. "
       "Bina design kiye. ViaKashmir Itinerary kar deta hai: viakashmiritinerary.in/signup"),
   li=("Your quote is the first thing a client judges you on. ViaKashmir Itinerary outputs a "
       "clean, branded itinerary - your name and look on every page. viakashmiritinerary.in/signup")),
 "compete": dict(
   subject="That client just booked with another agent",
   head='That client just booked<br/><span style="color:#9dd3aa;">with another agent.</span>',
   body=("They asked you and two others. The one who sent a clear, professional plan first "
         "got the booking. Speed and polish decide it - the builder gives you both."),
   accent="Same enquiry, three agents. The fastest clean quote wins.",
   upre="Win the next one", uhead="Be the quote<br/>they say yes to.",
   wa=("Client ne aapse aur 2 aur agents se pucha. Jisne pehle clean plan bheja, booking "
       "usko mili. Speed + polish dono chahiye - ViaKashmir Itinerary deta hai dono. "
       "viakashmiritinerary.in/signup"),
   li=("Every enquiry is a quiet race. The client asked you and two competitors; the first "
       "clear, professional plan wins. ViaKashmir Itinerary gets you there first, and on brand. "
       "viakashmiritinerary.in/signup")),
}
HOOK_ORDER = ["speed", "compete", "word", "professional", "complex"]
NONK = ["kerala", "rajasthan", "goa", "himalaya", "varanasi", "tajmahal"]

def market_cfg(market, date):
    """Return a full copy/photo config for one market on one date."""
    d = int(re.sub(r"\D", "", date) or "0")
    if market == "india":
        h = dict(HOOKS[HOOK_ORDER[d % len(HOOK_ORDER)]])
        h.update(badge="ViaKashmir Itinerary &nbsp;&mdash;&nbsp; For Travel Agents Across India",
                 photo=NONK[d % len(NONK)], feat=NONK[(d + 2) % len(NONK)])
        return _apply_research(h, market, date)
    if market == "kashmir":
        return _apply_research(dict(photo="kashmir", feat="kerala",
          badge="ViaKashmir Itinerary &nbsp;&mdash;&nbsp; For Kashmir Travel Agents",
          subject="The Kashmir package you quote every week",
          head='You know the Kashmir trip cold.<br/>Quote it <span style="color:#9dd3aa;">just as fast.</span>',
          body=("Dal, Gulmarg, Pahalgam, Sonamarg - you have planned it a hundred times. Stop "
                "retyping it for every enquiry. Build it once, send it branded in about two "
                "minutes, and add a Leh or Vaishno Devi leg without starting over."),
          accent="Peak season, full inbox. The agent who quotes fastest fills the rooms first.",
          upre="Srinagar season is on", uhead="Fill the season,<br/>not your evenings.",
          wa=("Kashmir package toh aap aankh band karke bana lete ho. Lekin har enquiry pe wahi "
              "Word doc dobara likhna? ViaKashmir Itinerary se ek baar banao, har baar 2 min me "
              "branded bhejo - aur Leh ya Vaishno Devi add karna ho toh bhi wahi tool. "
              "viakashmiritinerary.in/signup"),
          li=("Kashmir agents know the Dal-Gulmarg-Pahalgam circuit better than any software. The "
              "gap is the time lost retyping the same itinerary for every enquiry in peak season. "
              "ViaKashmir Itinerary builds it once and sends it branded in about two minutes, with "
              "room for the Leh or Vaishno Devi add-on. viakashmiritinerary.in/signup")), "kashmir", date)
    if market == "saudi":
        cfg = dict(photo="cappadocia", feat="maldives",
          badge="ViaKashmir Itinerary &nbsp;&mdash;&nbsp; For Travel Agents in Saudi Arabia",
          feature_body=("Istanbul, the Maldives, Baku, the Alps - one builder for every "
                        "destination your clients choose. Not tied to any single place."),
          subject="Build any client itinerary in two minutes",
          head='Whatever your client asks for,<br/>quote it <span style="color:#9dd3aa;">in two minutes.</span>',
          body=("Istanbul today, the Maldives next week, Baku after that - your clients go "
                "everywhere. Build a clean, branded day-by-day plan for any destination in about "
                "two minutes and send it while they are still deciding."),
          accent="The agency that sends the plan first wins the client. Be first.",
          ar_head="ابنِ أي برنامج رحلة في دقيقتين",
          ar_body="لأي وجهة يطلبها عميلك - برنامج يومي أنيق بعلامتك التجارية، جاهز قبل المنافسين.",
          upre="Whatever they ask for", uhead="Any destination,<br/>quoted in minutes.",
          wa=("Whatever your client asks for - Istanbul, the Maldives, Baku - build a branded, "
              "day-by-day plan in about two minutes and be the first agency to send it.\n"
              "مهما طلب عميلك - إسطنبول، المالديف، باكو - ابنِ برنامجًا يوميًا أنيقًا بعلامتك في دقيقتين وكن أول من يرسله.\n"
              "Start now: viakashmiritinerary.in/signup"),
          li=("Your clients book Istanbul, the Maldives, Baku, Bali - everywhere. ViaKashmir "
              "Itinerary builds a branded, day-by-day plan for any destination in about two "
              "minutes, so you reply first and win the client. viakashmiritinerary.in/signup"))
        return _apply_research(cfg, market, date)
    if market == "dubai":
        cfg = dict(photo="maldives", feat="alps",
          badge="ViaKashmir Itinerary &nbsp;&mdash;&nbsp; For Travel Agents in Dubai",
          feature_body=("Maldives, Switzerland, Thailand, Georgia - one builder for every "
                        "destination your clients choose. Not tied to any single place."),
          subject="Any destination, quoted in minutes",
          head='Your client picks the place.<br/>You send the plan <span style="color:#9dd3aa;">in minutes.</span>',
          body=("Maldives, Switzerland, Thailand, Georgia - Dubai clients travel everywhere and "
                "expect a polished plan the same day they ask. Build a branded, day-by-day "
                "itinerary for any destination in about two minutes."),
          accent="Same-day enquiry, same-day quote. That is how Dubai books.",
          ar_head="وجهة عميلك، برنامج جاهز في دقائق",
          ar_body="لأي مكان في العالم - برنامج يومي أنيق بعلامتك التجارية، جاهز للإرسال اليوم.",
          upre="Dubai moves fast", uhead="Any place.<br/>Quoted today.",
          wa=("Your client picks the place - Maldives, Switzerland, Thailand - and you send a "
              "branded, day-by-day plan the same day, in about two minutes.\n"
              "عميلك يختار الوجهة - المالديف، سويسرا، تايلاند - وأنت ترسل برنامجًا يوميًا أنيقًا بعلامتك في نفس اليوم خلال دقيقتين.\n"
              "Start now: viakashmiritinerary.in/signup"),
          li=("Dubai clients travel everywhere and expect a polished plan the same day. ViaKashmir "
              "Itinerary builds a branded, day-by-day itinerary for any destination in about two "
              "minutes. viakashmiritinerary.in/signup"))
        return _apply_research(cfg, market, date)
    raise SystemExit("unknown market: " + market)

def _apply_research(cfg, market, date):
    """If the daily research wrote destinations.json, override the hero/feature photo."""
    f = ROOT / "content" / "via-kashmir-itinerary" / date / "destinations.json"
    try:
        d = json.loads(f.read_text())
        m = d.get(market) or {}
        if m.get("photo") and (POOL / f"{m['photo']}.jpg").exists():
            cfg["photo"] = m["photo"]
        if m.get("feat") and (POOL / f"{m['feat']}.jpg").exists():
            cfg["feat"] = m["feat"]
    except Exception:
        pass
    return cfg

def li_rows(items, color):
    out = []
    for i, t in enumerate(items):
        bb = "" if i == len(items) - 1 else "border-bottom:1px solid #f3f4f5;"
        pad = "padding-bottom:12px;" if i == 0 else "padding:12px 0;"
        out.append(f'<tr><td style="{pad}{bb}"><p style="font-family:\'Inter\',Arial,sans-serif;'
                   f'font-size:13px;color:{color};line-height:1.65;margin:0;">{t}</p></td></tr>')
    return "".join(out)

def proof_cells():
    bars = ["#00361a,#1a4d2e", "#13677b,#004e5f", "#4a2400,#6b3600"]
    cells = []
    for (t, b), g in zip(PROOF, bars):
        cells.append(
          f'<td width="33%" valign="top" style="text-align:center;padding:0 12px;">'
          f'<div style="height:3px;background:linear-gradient(90deg,{g});border-radius:99px;width:28px;margin:0 auto 14px;"></div>'
          f'<p style="font-family:\'Manrope\',Arial,sans-serif;font-size:14px;font-weight:800;color:#191c1d;margin:0 0 6px;">{t}</p>'
          f'<p style="font-family:\'Inter\',Arial,sans-serif;font-size:12px;color:#717971;line-height:1.6;margin:0;">{b}</p></td>')
    return "".join(cells)

def arabic_block(cfg):
    if not cfg.get("ar_head"):
        return ""
    return (f'<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:6px 0 28px;"><tr>'
            f'<td dir="rtl" align="right" style="border-top:1px solid rgba(255,255,255,0.16);padding-top:20px;">'
            f'<p dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:23px;font-weight:700;color:#ffffff;line-height:1.5;margin:0 0 8px;">{cfg["ar_head"]}</p>'
            f'<p dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:14px;color:rgba(255,255,255,0.72);line-height:1.8;margin:0;">{cfg["ar_body"]}</p>'
            f'</td></tr></table>')

def email_html(cfg, preview=False):
    return f"""<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" /><meta name="x-apple-disable-message-reformatting" />
<title>{cfg['subject']}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800;900&family=Inter:wght@400;500;600;700&display=swap');
*{{margin:0;padding:0;box-sizing:border-box;}} body,table,td,a{{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}}
table,td{{mso-table-lspace:0pt;mso-table-rspace:0pt;}} img{{-ms-interpolation-mode:bicubic;border:0;display:block;}}
body{{background-color:#f3f4f5;margin:0;padding:0;width:100%!important;}}
@media only screen and (max-width:620px){{.email-wrapper{{width:100%!important;}}.mobile-pad{{padding-left:24px!important;padding-right:24px!important;}}.mobile-hero{{font-size:30px!important;line-height:1.1!important;}}.mobile-stack{{display:block!important;width:100%!important;padding:0 0 14px 0!important;}}}}
</style></head>
<body style="background-color:#f3f4f5;margin:0;padding:0;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#f3f4f5;line-height:1px;">{cfg['accent']}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f3f4f5;">
<tr><td align="center" style="padding:30px 16px 52px;">
<table role="presentation" class="email-wrapper" border="0" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;">

  <tr><td align="center" style="background-color:#ffffff;border-radius:16px;padding:20px 24px 16px;">
    <img src="{LOGO}" width="168" alt="ViaKashmir Itinerary" style="display:block;width:168px;height:auto;border:0;margin:0 auto;">
    <p style="font-family:'Inter',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.26em;text-transform:uppercase;color:#13677b;margin:9px 0 0;">Itinerary Builder</p>
  </td></tr>

  <tr><td style="height:18px;line-height:18px;font-size:18px;">&nbsp;</td></tr>

  <tr><td style="padding:0;">
    <img src="{img(cfg['photo'],preview)}" width="600" alt="Trips you plan" style="display:block;width:100%;height:260px;object-fit:cover;border-radius:20px 20px 0 0;">
  </td></tr>
  <tr><td bgcolor="#00361a" style="background-color:#00361a;background:linear-gradient(160deg,#00361a 0%,#1a4d2e 60%,#004e5f 100%);border-radius:0 0 20px 20px;padding:40px 48px 44px;" class="mobile-pad">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin-bottom:22px;"><tr>
      <td style="background-color:rgba(161,231,255,0.14);border-radius:99px;padding:7px 18px;">
        <span style="font-family:'Inter',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#b2ebff;">{cfg['badge']}</span>
      </td></tr></table>
    <h1 class="mobile-hero" style="font-family:'Manrope',Arial,sans-serif;font-size:38px;font-weight:900;color:#ffffff;line-height:1.1;letter-spacing:-0.03em;margin:0 0 20px;">{cfg['head']}</h1>
    <p style="font-family:'Inter',Arial,sans-serif;font-size:15px;color:rgba(255,255,255,0.7);line-height:1.75;margin:0 0 {'24px' if cfg.get('ar_head') else '30px'};max-width:450px;">{cfg['body']}</p>
    {arabic_block(cfg)}
    <table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>
      <td style="background-color:#0e3d2f;background-image:linear-gradient(135deg,#1a4d2e,#0e3d2f);border-radius:99px;">
        <a href="{SIGNUP}" target="_blank" style="display:inline-block;font-family:'Manrope',Arial,sans-serif;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;padding:16px 38px;"><span style="color:#ffffff;text-decoration:none;">Build my first itinerary &nbsp;&rarr;</span></a>
      </td></tr></table>
    <p style="font-family:'Inter',Arial,sans-serif;font-size:11px;color:rgba(255,255,255,0.4);margin:16px 0 0;letter-spacing:0.03em;">Set up in minutes &nbsp;&middot;&nbsp; Works for every destination</p>
  </td></tr>

  <tr><td style="height:24px;"></td></tr>

  <tr><td style="background-color:#1a4d2e;border-radius:14px;padding:22px 32px;" class="mobile-pad">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr>
      <td width="4" style="background-color:#9dd3aa;border-radius:99px;">&nbsp;</td>
      <td style="padding-left:18px;"><p style="font-family:'Manrope',Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;line-height:1.6;margin:0;">{cfg['accent']}</p></td>
    </tr></table>
  </td></tr>

  <tr><td style="height:32px;"></td></tr>

  <tr><td style="padding:0 4px 16px;"><p style="font-family:'Inter',Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;color:#717971;margin:0;">How a quote goes out today</p></td></tr>
  <tr><td>
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr>
      <td class="mobile-stack" width="292" valign="top" style="padding-right:8px;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr>
          <td style="background-color:#ffffff;border-radius:16px;padding:26px 24px 28px;">
            <p style="font-family:'Inter',Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#9e3a3a;margin:0 0 16px;">By hand</p>
            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">{li_rows(BEFORE,'#414942')}</table>
          </td></tr></table>
      </td>
      <td class="mobile-stack" width="292" valign="top" style="padding-left:8px;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr>
          <td style="background-color:#0e3d2f;border-radius:16px;padding:26px 24px 28px;">
            <p style="font-family:'Inter',Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#9dd3aa;margin:0 0 16px;">With ViaKashmir Itinerary</p>
            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">{li_rows(AFTER,'rgba(255,255,255,0.82)')}</table>
          </td></tr></table>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="height:30px;"></td></tr>

  <tr><td style="padding:0;"><img src="{img(cfg['feat'],preview)}" width="600" alt="Every destination" style="display:block;width:100%;height:230px;object-fit:cover;border-radius:18px 18px 0 0;"></td></tr>
  <tr><td style="background-color:#ffffff;border-radius:0 0 18px 18px;padding:22px 28px 24px;" class="mobile-pad">
    <p style="font-family:'Manrope',Arial,sans-serif;font-size:20px;font-weight:900;color:#191c1d;letter-spacing:-0.02em;margin:0 0 6px;">{FEATURE_TITLE}</p>
    <p style="font-family:'Inter',Arial,sans-serif;font-size:14px;color:#717971;line-height:1.65;margin:0;">{cfg.get("feature_body", FEATURE_BODY)}</p>
  </td></tr>

  <tr><td style="height:30px;"></td></tr>

  <tr><td bgcolor="#00361a" style="background-color:#00361a;background:linear-gradient(135deg,#00361a 0%,#1a4d2e 100%);border-radius:18px;padding:38px 40px;" class="mobile-pad" align="center">
    <p style="font-family:'Inter',Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.15em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin:0 0 12px;">{CTA_PRE}</p>
    <h3 style="font-family:'Manrope',Arial,sans-serif;font-size:25px;font-weight:900;color:#ffffff;letter-spacing:-0.025em;margin:0 0 12px;line-height:1.2;">{CTA_HEAD}</h3>
    <p style="font-family:'Inter',Arial,sans-serif;font-size:13px;color:rgba(255,255,255,0.6);line-height:1.65;margin:0 0 26px;max-width:390px;">{CTA_BODY}</p>
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center"><tr>
      <td style="background-color:#0e3d2f;background-image:linear-gradient(135deg,#1a4d2e,#0e3d2f);border-radius:99px;">
        <a href="{SIGNUP}" target="_blank" style="display:inline-block;font-family:'Manrope',Arial,sans-serif;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;padding:16px 40px;"><span style="color:#ffffff;text-decoration:none;">Build my first itinerary &nbsp;&rarr;</span></a>
      </td></tr></table>
    <p style="font-family:'Inter',Arial,sans-serif;font-size:12px;color:rgba(255,255,255,0.55);margin:18px 0 0;">Questions? <a href="{WA}" style="color:#9dd3aa;font-weight:700;text-decoration:underline;">Message us on WhatsApp</a></p>
  </td></tr>

  <tr><td style="height:30px;"></td></tr>

  <tr><td style="background-color:#ffffff;border-radius:16px;padding:30px 24px;">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr>{proof_cells()}</tr></table>
  </td></tr>

  <tr><td style="height:30px;"></td></tr>

  <tr><td style="background-color:#ffdcc4;border-radius:16px;padding:24px 32px;" class="mobile-pad">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr>
      <td valign="middle" style="padding-right:20px;">
        <p style="font-family:'Inter',Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;color:#6f3800;margin:0 0 7px;">{cfg['upre']}</p>
        <p style="font-family:'Manrope',Arial,sans-serif;font-size:18px;font-weight:900;color:#2f1400;line-height:1.25;margin:0;">{cfg['uhead']}</p>
      </td>
      <td valign="middle" align="right" style="white-space:nowrap;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>
          <td style="background:linear-gradient(135deg,#00361a 0%,#1a4d2e 100%);border-radius:99px;">
            <a href="{SIGNUP}" target="_blank" style="display:inline-block;font-family:'Manrope',Arial,sans-serif;font-size:13px;font-weight:800;color:#ffffff;text-decoration:none;padding:13px 24px;white-space:nowrap;"><span style="color:#ffffff;text-decoration:none;">Start building &nbsp;&rarr;</span></a>
          </td></tr></table>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="height:30px;"></td></tr>

  <tr><td bgcolor="#0e3d2f" align="center" style="background-color:#0e3d2f;border-radius:16px;padding:18px 20px;">
    <span style="font-family:'Manrope',Arial,sans-serif;font-size:14px;color:#ffffff;font-weight:700;">{CONTACT}</span>
  </td></tr>

  <tr><td style="height:18px;"></td></tr>

  <tr><td style="background-color:#ffffff;border-radius:16px;padding:26px 32px;" class="mobile-pad">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
      <tr><td align="center" style="padding-bottom:14px;">
        <p style="font-family:'Manrope',Arial,sans-serif;font-size:17px;font-weight:900;color:#00361a;letter-spacing:-0.02em;margin:0;">ViaKashmir Itinerary</p>
        <p style="font-family:'Inter',Arial,sans-serif;font-size:11px;color:#717971;margin:5px 0 0;">The simple itinerary builder for travel agents and tour operators. Every destination, one tool.</p>
      </td></tr>
      <tr><td style="background-color:#f3f4f5;height:1px;line-height:1px;font-size:1px;">&nbsp;</td></tr>
      <tr><td style="height:14px;"></td></tr>
      <tr><td align="center">
        <a href="{SIGNUP}" style="font-family:'Inter',Arial,sans-serif;font-size:11px;color:#1d5031;text-decoration:underline;">viakashmiritinerary.in/signup</a>
        &nbsp;&middot;&nbsp; <a href="#unsubscribe" style="font-family:'Inter',Arial,sans-serif;font-size:11px;color:#c1c9bf;text-decoration:underline;">Unsubscribe</a>
        &nbsp;&middot;&nbsp; <span style="font-family:'Inter',Arial,sans-serif;font-size:11px;color:#c1c9bf;">Srinagar, Kashmir</span>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="height:30px;"></td></tr>
</table></td></tr></table></body></html>"""

def card_html(cfg):
    head = cfg['head'].replace('<br/>', ' ').replace('<span style="color:#9dd3aa;">', '<span class="a">')
    photo_uri = (POOL / (cfg['photo'] + ".jpg")).resolve().as_uri()
    ar = ""
    if cfg.get("ar_head"):
        ar = f'<p dir="rtl" style="font-family:Tahoma,Arial;font-size:30px;font-weight:700;color:#9dd3aa;margin:18px 0 0;text-align:right;">{cfg["ar_head"]}</p>'
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@700;800;900&family=Inter:wght@400;600;700&display=swap');
*{{margin:0;padding:0;box-sizing:border-box;}}
body{{width:1080px;height:1350px;background:#f3f4f5;font-family:'Inter',Arial,sans-serif;overflow:hidden;}}
.wrap{{padding:50px;}}
.logo{{background:#fff;border-radius:28px;padding:30px;text-align:center;}}
.logo img{{height:46px;}}
.tag{{font-size:18px;font-weight:700;letter-spacing:0.26em;text-transform:uppercase;color:#13677b;margin-top:12px;}}
.photo{{height:430px;background-size:cover;background-position:center;border-radius:32px 32px 0 0;margin-top:30px;}}
.hook{{background:linear-gradient(160deg,#00361a,#1a4d2e 60%,#004e5f);border-radius:0 0 32px 32px;padding:44px 58px 50px;}}
.badge{{display:inline-block;background:rgba(161,231,255,0.16);color:#b2ebff;font-size:21px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:13px 28px;border-radius:99px;}}
h1{{font-family:'Manrope';font-size:56px;font-weight:900;color:#fff;line-height:1.05;letter-spacing:-0.03em;margin:24px 0 18px;}}
h1 .a{{color:#9dd3aa;}}
p.body{{font-size:26px;color:rgba(255,255,255,0.74);line-height:1.45;margin-bottom:32px;max-width:840px;}}
.cta{{display:inline-block;background:#9dd3aa;color:#0e3d2f;font-family:'Manrope';font-size:30px;font-weight:800;padding:26px 52px;border-radius:99px;}}
.contact{{background:#0e3d2f;border-radius:26px;margin-top:24px;padding:30px;text-align:center;color:#fff;font-family:'Manrope';font-size:29px;font-weight:700;}}
</style></head><body>
<div class="wrap">
  <div class="logo"><img src="https://wsrv.nl/?url=viakashmir.in/logo-colour.svg&w=520&output=png"><div class="tag">Itinerary Builder</div></div>
  <div class="photo" style="background-image:url('{photo_uri}');"></div>
  <div class="hook">
    <span class="badge">ViaKashmir Itinerary</span>
    <h1>{head}</h1>
    <p class="body">{cfg['accent']}</p>
    <span class="cta">Build my first itinerary &nbsp;&rarr;</span>
    {ar}
  </div>
  <div class="contact">contact@viakashmir.in &nbsp;|&nbsp; +91 918 605 1499</div>
</div></body></html>"""

MARKETS = ["india", "kashmir", "saudi", "dubai"]

def write_set(date, market, preview):
    cfg = market_cfg(market, date)
    out = ROOT / "content" / "via-kashmir-itinerary" / date / market
    (out / "img").mkdir(parents=True, exist_ok=True)
    (out / "email.html").write_text(email_html(cfg, preview), encoding="utf-8")
    (out / "whatsapp.txt").write_text(cfg["wa"] + "\n", encoding="utf-8")
    (out / "linkedin.txt").write_text(cfg["li"] + "\n", encoding="utf-8")
    (out / "meta.json").write_text(json.dumps({
        "date": date, "track": market, "market": market, "audience": "b2b-travel-agents",
        "product": "viakashmiritinerary.in", "bilingual": bool(cfg.get("ar_head")),
        "campaign_name": f"VK Itinerary - {market} - {date}",
        "subject": cfg["subject"], "cta_url": SIGNUP, "design": "Alpine",
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--market", choices=MARKETS)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--preview", action="store_true")
    a = ap.parse_args()
    markets = MARKETS if a.all else [a.market]
    if not markets or markets == [None]:
        raise SystemExit("pass --all or --market <india|kashmir|saudi|dubai>")
    for m in markets:
        print("wrote", write_set(a.date, m, a.preview))

if __name__ == "__main__":
    sys.exit(main())
