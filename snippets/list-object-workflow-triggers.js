// Author:  Jibril Sulaiman
// Date:    2026-10-14
// Run:     Paste into the browser console on any app.hubspot.com page while signed in.
//          Set PORTAL_ID and OBJECT_TYPES first.
// What:    Lists every workflow on the given objects with: on/off, trigger type,
//          whether it re-enrolls, and which properties its trigger and re-enrollment
//          watch (including the property names inside "property changed" events).
// Why:     Turning a Data Sync on (or back on) updates every matched record with
//          Stripe's values. Any workflow that starts or re-enrolls when one of those
//          properties changes can fire on old records. Run this before Step 6.
//          Uses HubSpot's internal automation endpoint; it may change without notice.

const PORTAL_ID = 'REPLACE_WITH_PORTAL_ID';
const OBJECT_TYPES = ['2-12345678', '2-23456789'];   // payments object, subscriptions object

const csrf = (document.cookie.match(/hubspotapi-csrf=([^;]+)/) || [])[1];
const H = { credentials: 'include', headers: { 'X-HubSpot-CSRF-hubspotapi': csrf } };

let all = [], after = null, n = 0;
do {
  const r = await fetch(`/api/automation/v4/flows?portalId=${PORTAL_ID}&limit=100` + (after ? '&after=' + after : ''), H);
  const j = await r.json();
  all = all.concat(j.results || []);
  after = j.paging && j.paging.next && j.paging.next.after;
  n++;
} while (after && n < 20);

const flows = all.filter((f) => OBJECT_TYPES.includes(f.objectTypeId));
const detail = {};
for (const f of flows) {
  detail[f.id] = await (await fetch(`/api/automation/v4/flows/${f.id}?portalId=${PORTAL_ID}`, H)).json();
}

const props = (o) => {
  const s = new Set();
  JSON.stringify(o, (k, v) => { if (k === 'property' && typeof v === 'string') s.add(v); if (k === 'eventTypeId') s.add('evt:' + v); return v; });
  return [...s];
};
// "Property value changed" triggers name the watched property in an hs_name filter.
const vals = (o) => {
  const s = [];
  JSON.stringify(o, (k, v) => { if (v && typeof v === 'object' && v.property === 'hs_name') s.push(JSON.stringify(v.operation && (v.operation.values || v.operation.value))); return v; });
  return s;
};

console.log(flows.map((f) => {
  const ec = detail[f.id].enrollmentCriteria || {};
  return [f.id, f.isEnabled ? 'ON' : 'off', ec.type, 'reEnroll:' + !!ec.shouldReEnroll,
    'trig:' + props(ec.listFilterBranch || ec.eventFilterBranches || {}).join(','),
    'reTrig:' + props(ec.reEnrollmentTriggersFilterBranches || []).join(','),
    'watches:' + [...new Set(vals(ec).concat(vals(ec.reEnrollmentTriggersFilterBranches || [])))].join(' '),
    f.name].join(' | ');
}).join('\n'));
