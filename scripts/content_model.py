"""Shared content model for the Hudace daily batch.

Brand voice = SAP.com: calm, authoritative, outcome-first, industry-framed,
proof over hype. No emojis, no em dashes, no exclamation. Region-agnostic.
"""

# Brand
BG_DEEP = "#05050D"
BG = "#0A0919"
BG_HERO = "#08080f"
WHITE = "#FFFFFF"
MUTED = "#9A9AAE"
ACCENT = "#1B90FF"

# Contact (verbatim, every asset)
PHONE_DISPLAY = "+91 82189 29990"
PHONE_E164 = "918218929990"
WA_LINK = "https://wa.me/918218929990"
EMAIL = "contact@hudace.com"
SITE = "hudace.com"
SITE_URL = "https://hudace.com"

# Social
IG_URL = "https://www.instagram.com/hudaceofficial/"
LI_URL = "https://www.linkedin.com/company/hudace"

# Hosted image base (self-hosted, committed to /public/email)
IMG_BASE = "https://leadloftexporter.vercel.app/email"

# Industries chosen this run (region-agnostic; rotation tracked in state.json)
INDUSTRY_A = "Education and Research"
INDUSTRY_B = "Construction and Real Estate"

# The daily batch: one email per marketing service plus a dedicated SchoolOS email.
# Deliverables are verbatim from the routine spec.
SERVICES = [
    {
        "key": "social-media",
        "name": "Social Media",
        "label": "SOCIAL MEDIA",
        "headline": "A social presence that compounds",
        "subhead": "Consistent short-form, feed and stories that turn attention into enquiries.",
        "pixabay": "cinematic content creator studio dark",
        "industry": INDUSTRY_B,
        "deliverables": [
            "6 short-form videos / month",
            "12 feed posts / month",
            "8 stories / month",
            "Captions and hashtag sets",
            "Content calendar and scheduling",
            "Community management (comments and DMs)",
            "Monthly performance report",
        ],
        "scope": "For a construction and real estate audience we plan the calendar around project milestones, walkthroughs and handover moments, so every post advances a live enquiry.",
        "proof": "In real estate work we have run, a disciplined posting cadence and reply routine moved passive followers into booked site visits within a quarter.",
        "future": "As the account matures we layer in paid amplification and creator collaborations on the same calendar, without adding management overhead.",
        "why": [
            "Cadence beats bursts. A fixed monthly output keeps the brand in feed between campaigns, so demand does not reset to zero each month.",
            "Short-form does the discovery, feed and stories do the proof. The mix is built to move a viewer from first watch to a saved contact.",
            "Community management closes the loop. Answered comments and DMs are where interest becomes a conversation, and we staff that daily.",
        ],
    },
    {
        "key": "seo",
        "name": "SEO / AEO / GEO / SRX",
        "label": "SEO / AEO / GEO / SRX",
        "headline": "Be found in search and in AI answers",
        "subhead": "Classic ranking plus visibility inside the AI-generated answers buyers now read first.",
        "pixabay": "dark data analytics search technology",
        "industry": INDUSTRY_A,
        "deliverables": [
            "Technical SEO audit and fixes",
            "Keyword and intent research",
            "On-page optimization (titles, meta, headings, schema)",
            "Content briefs and optimization",
            "Authority and backlink building",
            "Local SEO (profile, citations, maps)",
            "AEO: answer-engine optimization (FAQ, structured answers)",
            "GEO: visibility inside AI-generated answers",
            "SRX: search experience and Core Web Vitals",
            "Monthly ranking and traffic report",
        ],
        "scope": "For an education and research audience we target the questions families and administrators actually ask, then structure the answers so both search engines and AI assistants can quote them.",
        "proof": "In education-sector work we have run, fixing technical debt and answer structure recovered rankings that paid ads had been masking.",
        "future": "The same content foundation feeds an AEO and GEO program, so the brand keeps surfacing as search shifts from links to answers.",
        "why": [
            "Search is splitting in two. Ten blue links and AI answers reward different structures, and we optimize for both in one program.",
            "Intent research decides the work. We rank for the queries that carry a decision, not vanity terms that never convert.",
            "Technical health is the multiplier. Core Web Vitals and clean schema let every content gain actually register in results.",
        ],
    },
    {
        "key": "website",
        "name": "Website Design",
        "label": "WEBSITE DESIGN",
        "headline": "A website built to convert",
        "subhead": "Fast, mobile-first and structured so visitors become leads, not bounces.",
        "pixabay": "dark modern web design workspace",
        "industry": INDUSTRY_B,
        "deliverables": [
            "Custom multi-page website",
            "Mobile-first responsive build",
            "Booking, lead, and contact forms",
            "CMS to edit content yourself",
            "SEO-ready structure and speed",
            "Analytics and WhatsApp integration",
            "Hosting and domain setup",
            "Launch and handover",
        ],
        "scope": "For a construction and real estate brand we lead with the portfolio and a clear path to enquiry, so a serious buyer can reach you from any page in one tap.",
        "proof": "In real estate work we have run, moving contact and booking forms above the fold turned a brochure site into a steady source of qualified leads.",
        "future": "The CMS and analytics we hand over let the site keep improving after launch, with new pages and landing tests you can run yourself.",
        "why": [
            "Speed is the first impression. A mobile-first, fast build keeps the visit alive long enough for the offer to land.",
            "Every page ends in an action. Booking, lead and WhatsApp entry points are placed where intent peaks, not buried in a menu.",
            "You own the edits. A real CMS means content stays current without a developer in the loop, so the site never goes stale.",
        ],
    },
    {
        "key": "erp",
        "name": "ERP Building",
        "label": "ERP BUILDING",
        "headline": "Software shaped to how you actually run",
        "subhead": "Custom modules on the Xenon AI platform, from CRM to billing to HR, in one system.",
        "pixabay": "dark enterprise software dashboard servers",
        "industry": INDUSTRY_B,
        "deliverables": [
            "Discovery and module blueprint",
            "Custom modules (CRM, inventory, billing, HR, and more)",
            "Role-based access and dashboards",
            "Workflow automations",
            "Integrations (payments, messaging, APIs)",
            "Web and mobile access",
            "Training and documentation",
            "Ongoing support and iterations",
        ],
        "scope": "For a construction and real estate operator we map the flow from lead to project to handover into one system, so sales, site and finance work from the same record.",
        "proof": "In operations work we have run, replacing a stack of spreadsheets with role-based dashboards cut the daily reporting scramble to a single screen.",
        "future": "Because it is modular, the build starts with the process that hurts most today and grows into a full operating system over time.",
        "why": [
            "Off-the-shelf bends your business to the tool. Custom modules bend the tool to your process, so adoption is not a fight.",
            "One record, many roles. Role-based dashboards give each team its own view of the same truth, and remove the reconciliation step.",
            "Automation is the payback. The workflows we wire in remove the repetitive handoffs that quietly consume a working day.",
        ],
    },
    {
        "key": "ai-work-studio",
        "name": "AI Work Studio",
        "label": "AI WORK STUDIO",
        "headline": "Cinematic film, no film crew",
        "subhead": "A finished 60-second film, social cuts and stills from Xenon Studio in seven working days.",
        "pixabay": "cinematic film dark moody lighting",
        "industry": INDUSTRY_A,
        "deliverables": [
            "60-second cinematic film",
            "Three 15-second social cuts",
            "Ten AI-generated stills",
            "Script and concept included",
            "Delivered in seven working days, no film crew",
        ],
        "scope": "For an education and research brand we translate the campus story and outcomes into a cinematic narrative, without the schedule and cost of a location shoot.",
        "proof": "In brand-film work we have run, an AI-produced hero film and its cuts covered a full launch calendar that a single traditional shoot could not.",
        "future": "Once the look is set we can refresh cuts and stills each season on the same concept, so the brand always has current creative on hand.",
        "why": [
            "Speed changes what you can say. A seven-day turnaround means creative keeps pace with the campaign, not the other way around.",
            "One shoot, a full kit. The film, the cuts and the stills come from one concept, so every channel stays on message.",
            "No crew, no waiting. Removing the production bottleneck lets budget go to reach instead of logistics.",
        ],
    },
    {
        "key": "schoolos",
        "name": "SchoolOS",
        "label": "HUDACE SCHOOLOS",
        "headline": "One system to run the whole school",
        "subhead": "Admissions to fees to report cards, with Nectar automating the routine admin.",
        "pixabay": "modern school classroom students dark",
        "industry": INDUSTRY_A,
        "deliverables": [
            "Admissions: online enquiry to enrollment",
            "Student records: profiles, documents, history",
            "Attendance: daily and period, parent alerts",
            "Fees: invoices, online payments, reminders, receipts",
            "Examinations: marks, grading, report cards",
            "Timetable: classes, teachers, substitutions",
            "Communication: announcements and parent app",
            "Transport: routes, vehicles, live tracking",
            "Library: catalog, issue and return",
            "HR and payroll: staff and salaries",
            "Reports: management dashboards",
        ],
        "scope": "For an education and research institution the modules connect front office, classroom and finance, so a single student record follows the learner from enquiry to report card.",
        "proof": "In school operations we have supported, moving fees and attendance online removed the reconciliation and follow-up that used to consume the front office each morning.",
        "future": "With Nectar handling routine admissions, attendance and fee admin, staff time shifts from data entry to the students in front of them.",
        "why": [
            "One record, not ten registers. A single student profile across modules ends the double entry and the version conflicts.",
            "Parents stay informed automatically. Attendance alerts, fee reminders and announcements go out without staff chasing them.",
            "Leadership sees the whole school. Management dashboards turn scattered files into decisions you can make on the same day.",
        ],
    },
]
