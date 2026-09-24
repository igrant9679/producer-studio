# SCRIPT — Tableau Next at CommunityForce (locked narration)

Voice: Kokoro `af_heart`, speed 0.95. One line per scene; ids match `compositions/sNN-*.html`
and `assets/vo/sNN.wav`. Numbers are written as they should be spoken.

## s01 — Hook

Every CommunityForce opportunity, lead, and campaign is already in Salesforce. So that's where we keep our analytics too. This is how we use Tableau Next to run pipeline analytics — without ever leaving the platform.

## s02 — Where it lives

Tableau Next is a native Salesforce app. Open it from the App Launcher, or from Setup: search for Tableau Next and click "Go to Tableau Next". Either way you land on Home, where every asset the team has built is listed in one place — models, metrics, visualizations, and dashboards.

## s03 — Five building blocks

Everything in Tableau Next is built from five kinds of assets. Data connects your sources. Data Transform shapes it. A Semantic Model gives it business meaning. Visualizations chart it. And Dashboards bring it all together, in front of the people who need it.

## s04 — Connecting data

We start with data. Click Add, choose Data, and Tableau Next pulls Salesforce data objects straight from our org — opportunities, leads, campaign members, activities. We can also upload CSV files, or add a connector for outside systems. Under the hood, everything flows through Data three sixty — Salesforce Data Cloud.

## s05 — The semantic model

Once the data is in, we model it. The CommunityForce Pipeline semantic model joins seven data objects — Activity, Campaign Member, Lead, Opportunity Fact, Opportunity Line, Pipeline Snapshot, and Quota — and defines twelve metrics on top of them. Dimensions and measures get their business names here, once, so every chart downstream speaks the same language.

## s06 — Build a visualization

From the model, click Create Visualization. Drag a measure onto columns and a dimension onto rows — here, Sum of Total Price by Product Name — and Tableau Next draws the chart. Most of the Tableau chart library is here, with forecasting and reference lines built in. Global Administrator licenses and Enterprise SaaS fees lead our revenue by product.

## s07 — The Pipeline Overview dashboard

Visualizations become dashboards. Our Pipeline Overview dashboard combines seventeen visualizations across six pages. At a glance: nine hundred eighty thousand dollars of open pipeline. Two hundred ninety-eight thousand weighted. Three hundred forty-one open opportunities — all filterable by market category, client size, and stage.

## s08 — Embedded where the team works

And because it's Salesforce, the dashboard lives right inside the Sales app, as its own Pipeline Analytics tab. Reps filter, hover, and drill without switching tools. Sales Performance tracks all five thousand opportunities by close year, with a leaderboard by owner and pipeline by forecast category. Pipeline Generation follows sixteen thousand leads from source to conversion.

## s09 — The executive view

The same model powers an executive view for leadership — total opportunity value, product revenue, quota, and campaign reach — rolled up on a single page. One model, every audience.

## s10 — Close

Data can arrive from anywhere through the Data three sixty ingestion API, land as data lake objects, and flow straight into Tableau Next. That's how CommunityForce turns Salesforce data into decisions — without leaving Salesforce.
