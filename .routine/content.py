# -*- coding: utf-8 -*-
# Hudace daily content batch generator: emails, whatsapp, linkedin, outreach.
DATE = "2026-07-17"
INDUSTRIES = ["Retail", "Construction and Real Estate"]

WA = "https://wa.me/918218929990"
SITE = "https://hudace.com"
PHONE = "+91 82189 29990"
EMAIL = "contact@hudace.com"
DOMAIN = "hudace.com"
IG = "https://www.instagram.com/hudaceofficial/"
LI = "https://www.linkedin.com/company/hudace"

# base URL where images are hosted after push
IMGBASE = "https://leadloftexporter.vercel.app/email"

SERVICES = [
  {
    "key":"social","name":"Social Media","subject":"Social Media",
    "photo_q":"cinematic dark studio neon","photo":"social.jpg",
    "hero":"Social presence that compounds",
    "sub":"A full content engine, planned and shipped every month.",
    "deliverables":[
      "6 short-form videos / month","12 feed posts / month","8 stories / month",
      "Captions and hashtag sets","Content calendar and scheduling",
      "Community management (comments and DMs)","Monthly performance report"],
    "hooks":[
      ("Consistency the algorithm rewards","Twenty-six planned assets a month keep the account active on the days reach is decided, not the days you find time to post."),
      ("A calendar, not a scramble","Scheduling and a live calendar mean the month is booked in advance, so nothing ships late and nothing is left to chance."),
      ("Conversations that close","Managed comments and DMs turn reach into replies, and replies into booked conversations with real buyers.")],
    "future":"As the account matures we layer in paid amplification and creator collaborations on the assets that already prove out organically.",
  },
  {
    "key":"seo","name":"SEO / AEO / GEO / SRX","subject":"SEO, AEO, GEO and SRX",
    "photo_q":"dark data analytics screen cinematic","photo":"seo.jpg",
    "hero":"Found first, in search and in AI",
    "sub":"Ranking, answer engines, and AI answers on one program.",
    "deliverables":[
      "Technical SEO audit and fixes","Keyword and intent research",
      "On-page optimization (titles, meta, headings, schema)","Content briefs and optimization",
      "Authority and backlink building","Local SEO (profile, citations, maps)",
      "AEO: answer-engine optimization (FAQ, structured answers)",
      "GEO: visibility inside AI-generated answers","SRX: search experience and Core Web Vitals",
      "Monthly ranking and traffic report"],
    "hooks":[
      ("Demand you already have","Intent research targets the searches buyers run before they buy, so the traffic you earn is traffic that converts."),
      ("Visible where answers are read","AEO and GEO place the brand inside featured answers and AI responses, where a growing share of decisions now starts."),
      ("Speed that holds the rank","SRX and Core Web Vitals work keeps pages fast, so hard-won rankings are not lost to a slow experience.")],
    "future":"Once core terms rank we expand into supporting clusters and programmatic pages, widening the surface area that brings in qualified visits.",
  },
  {
    "key":"website","name":"Website Design","subject":"Website Design",
    "photo_q":"dark laptop web design cinematic","photo":"website.jpg",
    "hero":"A website built to convert",
    "sub":"Fast, mobile-first, and ready to capture leads on day one.",
    "deliverables":[
      "Custom multi-page website","Mobile-first responsive build",
      "Booking, lead, and contact forms","CMS to edit content yourself",
      "SEO-ready structure and speed","Analytics and WhatsApp integration",
      "Hosting and domain setup","Launch and handover"],
    "hooks":[
      ("Every visit has a next step","Booking, lead, and contact forms mean traffic has somewhere to go, so interest is captured instead of lost."),
      ("Fast where it is judged","A mobile-first, speed-tuned build meets buyers on the device they actually use and holds their attention past the first second."),
      ("Yours to run","A CMS and clean handover let the team edit content without a developer, so the site keeps pace with the business.")],
    "future":"After launch we connect the site to the wider growth program, feeding SEO and campaigns into pages designed to turn visits into enquiries.",
  },
  {
    "key":"erp","name":"ERP Building","subject":"Custom Business Software and SaaS",
    "photo_q":"dark server room cinematic blue","photo":"erp.jpg",
    "hero":"Software shaped to how you operate",
    "sub":"Custom modules, automations, and dashboards on one system.",
    "deliverables":[
      "Discovery and module blueprint","Custom modules (CRM, inventory, billing, HR, and more)",
      "Role-based access and dashboards","Workflow automations",
      "Integrations (payments, messaging, APIs)","Web and mobile access",
      "Training and documentation","Ongoing support and iterations"],
    "hooks":[
      ("One system, not ten tabs","Custom modules put CRM, inventory, billing, and HR on one platform, so the team stops stitching spreadsheets together by hand."),
      ("Automations that remove the busywork","Workflow automation handles the repeatable steps, freeing people for the work that actually needs a person."),
      ("Decisions on live numbers","Role-based dashboards surface the right figures to the right people, so choices are made on current data, not last week's export.")],
    "future":"The blueprint is built to extend, so new modules and integrations are added as the operation grows without replacing what already works.",
  },
  {
    "key":"aistudio","name":"AI Work Studio","subject":"AI Cinematic Video",
    "photo_q":"cinematic film dark moody lighting","photo":"aistudio.jpg",
    "hero":"A cinematic film without a film crew",
    "sub":"Concept to delivery in seven working days.",
    "deliverables":[
      "60-second cinematic film","Three 15-second social cuts",
      "Ten AI-generated stills","Script and concept included",
      "Delivered in seven working days, no film crew"],
    "hooks":[
      ("Broadcast look, no production week","AI generation delivers a cinematic film without location, crew, or the schedule and cost a shoot demands."),
      ("One shoot, a month of assets","The film, three social cuts, and ten stills come from one concept, so a single production feeds every channel."),
      ("Idea to asset in seven days","A seven working day turnaround means the campaign runs while the moment is still live, not after it has passed.")],
    "future":"Proven concepts become a repeatable format, so the next film ships faster and the brand builds a recognisable visual signature.",
  },
  {
    "key":"schoolos","name":"SchoolOS (School ERP)","subject":"SchoolOS School ERP",
    "photo_q":"modern school classroom dark cinematic","photo":"schoolos.jpg",
    "hero":"One connected system for the whole school",
    "sub":"Admissions to reports, with AI handling the routine admin.",
    "deliverables":[
      "Admissions: online enquiry to enrollment","Student records: profiles, documents, history",
      "Attendance: daily and period, parent alerts","Fees: invoices, online payments, reminders, receipts",
      "Examinations: marks, grading, report cards","Timetable: classes, teachers, substitutions",
      "Communication: announcements and parent app","Transport: routes, vehicles, live tracking",
      "Library: catalog, issue and return","HR and payroll: staff and salaries",
      "Reports: management dashboards"],
    "hooks":[
      ("Admissions that do not leak","An online funnel from enquiry to enrollment keeps every applicant tracked, so interested families are followed up, not forgotten."),
      ("Fees collected on time","Online payments, automated reminders, and receipts shorten the collection cycle and cut the manual chasing to a fraction."),
      ("Parents informed without extra work","Attendance alerts and a parent app keep families updated automatically, so staff spend less time relaying and more time teaching.")],
    "future":"Built-in AI takes on routine admin across admissions, attendance, and fees, surfacing only the priority issues that need a person.",
    "is_school":True,
  },
]

def scope_line(s):
    inds = " and ".join(INDUSTRIES).lower()
    if s.get("is_school"):
        return "Scope: SchoolOS runs on one connected system, so a school moves off scattered registers and spreadsheets and onto a single record everyone works from."
    return f"Scope: {s['name']} delivered for {inds} operators, framed around the outcomes that move each business rather than a generic playbook."

def proof_line(s):
    if s.get("is_school"):
        return "Proof: in education operations we have cut fee collection cycles and reduced manual admin, so staff hours move back toward teaching."
    if s['key'] in ("erp","website"):
        return "Proof: in retail operations we have replaced disconnected tools with one system, and in real estate we have turned slow sites into lead-capturing ones."
    if s['key']=="seo":
        return "Proof: in retail and real estate we have grown qualified organic visits by targeting the searches buyers actually run before they decide."
    return "Proof: in retail and real estate we have turned a quiet presence into a steady stream of enquiries with a planned, consistent output."
