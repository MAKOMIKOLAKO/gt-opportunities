# Handoff: Campus Opportunity Finder (Georgia Tech)

## Overview
A searchable, filterable directory consolidating VIP (Vertically Integrated Projects) teams, research labs, and technical student organizations at Georgia Tech, plus a crowdsourced submission form. Solves fragmentation across the VIP catalog, CampusGroups (~600 orgs, no technical/non-technical split), and word-of-mouth lab info.

## About the Design Files
The bundled file (`Campus Opportunity Finder.dc.html`) is a **design reference prototype** built in HTML/React-like syntax for a design tool — it is not production code to copy directly. Recreate this design in the target codebase's existing environment (React, Vue, etc.) using its established patterns, component library, and data layer. If no frontend framework exists yet, choose the most appropriate one for the project.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and layout are final intent. Sample org data is clearly placeholder — replace with real data from the VIP catalog / CampusGroups / lab outreach.

## Screens / Views
Single-page app with three view states (directory, detail, submit), sharing one sticky header.

### Header (all views)
- Navy (#003057) background, full-width, sticky top.
- Left: 34×34px rounded-square gold (#B3A369) logo mark with "GT" in navy, bold; wordmark "Opportunity Finder" (16px/700, white) + subtitle "VIP · Labs · Student Orgs" (11px, ~75% opacity).
- Nav: "Directory" and "Submit an Org" pill buttons (white text, subtle white-overlay bg when active, transparent otherwise, 9px/16px padding, 8px radius).
- Right: "Georgia Institute of Technology" label, 12px, 60% opacity white.

### 1. Directory (default view)
**Purpose:** Browse and filter all orgs; entry point to detail pages.
- Page heading: "Find your next project" (30px/800, navy, -0.5px tracking) + one-line subcopy (15px, gray #54585A).
- **Search bar**: full-width text input with left-inset search glyph, placeholder guiding example queries, 12px radius, 1.5px #D6DBD4 border.
- **Grid/List toggle**: segmented control to the right of search, navy fill on active segment.
- **Filter row**: "Type" pill group (All / VIP Teams / Research Labs / Student Orgs) — each pill has a small color-coded dot (VIP=navy #003057, Lab=purple #5F249F, Org=teal #008C95) and toggles active state (navy bg/white text when selected); "Discipline" native `<select>` (All Disciplines, CS, ECE, ME, ISyE, BME, CEE, Multidisciplinary); "Clear filters" text link appears only when a filter is active.
- Result count label above results (13px, gray, medium weight).
- **Grid view**: responsive card grid (`repeat(auto-fill, minmax(300px,1fr))`, 16px gap). Each card: white bg, 1.5px #D6DBD4 border, 14px radius, 20px padding; top row has 44px rounded-square colored initials icon + status pill (Open=green #EAF6E9/#2f7a3a, Rolling=amber #FFF3D6/#8a6d00, Closed=gray #F1F1F1/#6b6f71); org name (16px/700 navy) + "{typeLabel} · {discipline}" (12.5px gray); 2-3 line blurb (13px); tag chips (11px, gray text, cream #F9F6E5 bg, #D6DBD4 border). Hover: lift (translateY(-2px)), gold border, soft shadow.
- **List view**: table-like rows in a bordered white panel — columns Name / Type / Discipline / Commitment / Status, header row on cream (#F9F6E5) bg, 11.5px/700 uppercase gray labels; each row hover-highlights cream.
- Empty state: centered message when no results match filters.
- Clicking any card/row navigates to Detail view for that org.

### 2. Org Detail
**Purpose:** Full info on one org, with an apply CTA.
- "← Back to directory" text button (navy, 13.5px/600) above a single white bordered card (16px radius, 32px padding).
- Header: 56px icon + org name (24px/800 navy) + status pill + "{typeLabel} · {discipline}" subline.
- Full description paragraph (15px, 1.65 line-height).
- **Info grid** (auto-fit minmax 180px, cream bg panel, 12px radius, 20px padding): Commitment, Credit/Pay, Faculty Lead, Meets — each an 11px uppercase label + 14px/600 value.
- Skills/keywords as tag chips (navy text, cream bg, bordered).
- Footer row: navy "How to Apply" button (link, 9px radius) + "Contact: {email}" text.

### 3. Submit an Org
**Purpose:** Crowdsourced submission form (no review-queue admin UI in this pass — submissions are described as entering a queue, but there is no moderator screen to build here).
- Heading "Submit an organization" (26px/800 navy) + subcopy explaining moderation.
- Single white bordered card (14px radius, 28px padding) form, fields: Organization name* (text), Type* (select: VIP Team / Research Lab / Student Org), Discipline/College (select), Short description* (textarea, 4 rows), Skills/keywords (comma-separated text), Your GT email* (text). All inputs 1.5px #D6DBD4 border, 9px radius, 14px font.
- Info callout (cream bg, bordered) noting 3-5 day review turnaround.
- Full-width navy "Submit for review" button.
- On submit: success state replaces the form — checkmark badge (gold circle, navy check), confirmation text referencing the submitted org name, "Submit another" outlined button to reset.

### Footer (all views)
Centered disclaimer: "Built by students, for students — not an official Georgia Tech resource." 12px gray, top border.

## Interactions & Behavior
- View switching is client-side state (directory/detail/submit) — no page reloads.
- Search filters by substring match across name, blurb, and tags (case-insensitive).
- Type filter and discipline filter combine with search (AND logic).
- Grid/List is a display toggle only — same filtered dataset.
- Form has basic HTML5 `required` validation on name, description, email; no format/email validation beyond that in the prototype — add real email/domain validation (e.g. restrict to @gatech.edu) in production.
- No animations beyond a simple fade-in on view mount and card hover lift/shadow transitions (~0.15s ease).

## State Management
Suggested state shape:
- `view`: 'directory' | 'detail' | 'submit'
- `layout`: 'grid' | 'list'
- `query`: string (search text)
- `typeFilter`: 'All' | 'VIP' | 'Lab' | 'Org'
- `discipline`: string
- `selectedOrgId`: string/number
- Form fields: name, type, discipline, description, tags, email
- `submitted`: boolean (post-submit success state)

Data fetching: replace the in-file `ORGS` placeholder array with a real API/database call returning org records (see Design Tokens/shape below). Submission form should POST to a review-queue backend (not built in this pass) rather than just setting local `submitted` state.

## Design Tokens
**Colors** (Georgia Tech brand):
- Navy: #003057 (primary, headers, CTAs, VIP type)
- Tech Gold: #B3A369 (logo mark accent — avoid as body text on white per GT accessibility guidance)
- Gray Matter: #54585A (secondary text)
- Pi Mile: #D6DBD4 (borders)
- Diploma (cream): #F9F6E5 (page bg, subtle panel bg)
- Accent — Impact Purple #5F249F (Research Lab type), Olympic Teal #008C95 (Student Org type)
- Status: Open green #EAF6E9/#2f7a3a, Rolling amber #FFF3D6/#8a6d00, Closed gray #F1F1F1/#6b6f71

**Typography:** Inter (400/500/600/700/800), sans-serif only. Page H1 ~26-30px/800; card titles 16px/700; body 13-15px; labels 11-12px/700 uppercase with letter-spacing.

**Radius:** 6-9px small controls, 12-16px cards/panels, 999px pills.

**Shadows:** subtle only on card hover (`0 8px 24px rgba(0,48,87,0.1)`).

## Assets
No logo image used — "GT" initials mark built from color/type only (do not recreate the official Georgia Tech logo; use the real approved GT logo asset in production per brand guidelines at brand.gatech.edu). No other images; org "icons" are colored initials placeholders.

## Files
- `Campus Opportunity Finder.dc.html` — full working prototype (all three views, sample data, filtering logic in the embedded script).
