from fastapi import APIRouter

from app.api.v1 import (
    auth,
    workspaces,
    leads,
    pipeline,
    tasks,
    inbox,
    playbooks,
    templates,
    settings,
    extension,
    integrations,
    search_scrapers,
    ai,
    whatsapp,
    linkedin_bridge,
    campaigns,
    tracking,
)

api_router = APIRouter(prefix="/api/v1")

api_router.include_router(auth.router)
api_router.include_router(workspaces.router)
api_router.include_router(leads.router)
api_router.include_router(pipeline.router)
api_router.include_router(tasks.router)
api_router.include_router(inbox.router)
api_router.include_router(playbooks.router)
api_router.include_router(templates.router)
api_router.include_router(settings.router)
api_router.include_router(integrations.router)
api_router.include_router(search_scrapers.router)
api_router.include_router(extension.router)
api_router.include_router(ai.router)
api_router.include_router(whatsapp.router)
api_router.include_router(linkedin_bridge.router)
api_router.include_router(campaigns.router)
api_router.include_router(tracking.router)
