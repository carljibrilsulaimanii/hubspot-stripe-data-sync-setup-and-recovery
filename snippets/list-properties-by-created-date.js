// Author:  Jibril Sulaiman
// Date:    2026-10-14
// Run:     Paste into the browser console (DevTools → Console) on any app.hubspot.com
//          page while signed in to the portal. Set PORTAL_ID and OBJECT_TYPE first.
// What:    Groups a custom object's non-HubSpot properties by the day they were created
//          and lists them, oldest first.
// Why:     Data Sync creates every field it maps in one go when the sync is first set up.
//          If a reconnect wipes the mappings, the fields created that first day are the
//          old mapping targets, and anything added later was created by your own
//          workflows and must NOT be mapped. Uses HubSpot's internal properties endpoint
//          (the same one the property settings page uses); it may change without notice.

const PORTAL_ID = 'REPLACE_WITH_PORTAL_ID';   // e.g. 12345678
const OBJECT_TYPE = '2-12345678';             // the Data Sync object's type id

const csrf = (document.cookie.match(/hubspotapi-csrf=([^;]+)/) || [])[1];
const H = { credentials: 'include', headers: { 'X-HubSpot-CSRF-hubspotapi': csrf } };
const r = await fetch(`/api/properties/v4/${OBJECT_TYPE}?portalId=${PORTAL_ID}`, H);
const j = await r.json();

window.__props = j
  .filter((x) => !x.property.hubspotDefined && !x.property.deleted)
  .map((x) => x.property)
  .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.name.localeCompare(b.name));

// 1) How many fields were created on each day, and by which user id.
const g = {};
window.__props.forEach((p) => {
  const k = (p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : '?') + ' u' + (p.createdUserId || '-');
  g[k] = (g[k] || 0) + 1;
});
console.log(JSON.stringify({ total: window.__props.length, groups: g }, null, 2));

// 2) The names, with their creation day. The earliest day is the original mapping.
console.log(window.__props.map((p) => p.name + '@' + new Date(p.createdAt).toISOString().slice(0, 10)).join('\n'));
