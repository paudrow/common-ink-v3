import { PLANS, TRIAL_DAYS } from "../../core/billing.ts";
import { SUPPORT, wayIn, type SitePage, type Visit } from "./layout.ts";

const plans = `
<dl class="plans">
  <div><dt>Monthly</dt><dd class="price">$${PLANS.month.price}<span> a month</span></dd></div>
  <div><dt>Yearly</dt><dd class="price">$${PLANS.year.price}<span> a year</span></dd><dd>$${PLANS.year.perMonth} a month, paid once a year</dd></div>
</dl>`;

const charging = (visit: Visit) => `
<p class="lede">One plan, with everything in Common Ink. Start with a ${TRIAL_DAYS}-day free trial. No card needed.</p>
${plans}
<div class="ways-in">${wayIn(visit)}</div>`;

const free = `
<p class="lede">Common Ink is free during early access. When paid plans start, there will be one plan with a ${TRIAL_DAYS}-day free trial, and you'll be told before anything is charged.</p>
${plans}
<p class="fine">To join early access, write to <a href="mailto:${SUPPORT}">${SUPPORT}</a>.</p>`;

export const pricing: SitePage = {
  path: "/pricing",
  title: "Pricing",
  description: `One plan with everything in Common Ink: ${PLANS.month.label}, or ${PLANS.year.label}, after a ${TRIAL_DAYS}-day free trial.`,
  kind: "prose",
  body: (visit) => `
${visit.billing ? charging(visit) : free}
<h2 id="included">What's included</h2>
<p>Every feature, every agent you connect, every workspace you make, and the people you share them with.</p>
<h2 id="teams">Teams</h2>
<p>A workspace is paid for by the person who made it. The people you invite into it can edit at no charge.</p>
<h2 id="ending">If your plan ends</h2>
<p>Nothing is locked. The workspaces you own turn read-only, so everyone in them can still read, search and copy out every note. Subscribe again and they can be changed at once.</p>
<h2 id="cancel">Cancel at any time</h2>
<p>Change your card, see invoices, switch plans or cancel in Settings, under Plan. A plan you cancel lasts to the end of the period you paid for.</p>`,
};
