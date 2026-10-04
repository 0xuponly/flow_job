import { describe, expect, it } from 'vitest'
import {
  LICENCE_GATED_SCORE_CAP,
  NO_BASE_CV_SCORE,
  compatibilitySignals,
  extractEducationLevel,
  extractRoleTitles,
  extractTechnicalTerms,
  extractYearsExperience,
  scoreCompatibility,
  scoreCompatibilityStructured
} from './fitHeuristic'
// ---------------------------------------------------------------------------
// Labelled fixture set
// ---------------------------------------------------------------------------
// 49 realistic postings across three CVs (a financial/data analyst, a software
// engineer, a data/BI analyst), labelled by hand before the scorer was
// touched:
//
//   match — a recruiter would call this a relevant application for that CV.
//   near  — adjacent: right profession or right industry but the wrong
//           function, or a seniority stretch. Worth a look, not a clear fit.
//   miss  — irrelevant to that CV's industries, skills and scope of work. This
//           is the population the user is complaining about: marketing, sales,
//           HR, logistics, teaching, mechanical and civil engineering, UX
//           research, account management.
//   block — a hard incompatibility: a profession the CV has no licence,
//           registration or charter to enter.
//
// The bands asserted below are properties the score must have, not numbers
// fitted to it. They are anchored on matchGrade's own cut points (0.45 = grade
// C, 0.75 = A) so the score and the badge the user sees agree, and on the scan
// floor HEURISTIC_FLOOR = 0.25 that jobSearch.ts compares against.
type Label = 'match' | 'near' | 'miss' | 'block'

export const CV_FINANCE = `Ana Ferreira
Financial & Data Analyst. 6 years of experience.
Financial Analyst (2021-present, retail banking): monthly close reporting, IFRS financial statements, revenue recognition, variance analysis, audit support, financial modelling.
Commercial Analyst (2019-2021, SaaS): ARR and NRR reporting, pricing analysis, Power BI dashboards for the commercial leadership team.
Data Analyst (2018-2019, operations): SQL over the warehouse, weekly KPI reporting in Tableau.
Skills: financial modelling, budgeting, forecasting, variance analysis, revenue recognition, IFRS, SQL, Power BI, Tableau, Excel, Python (pandas).
Tools: Excel (advanced), SQL, Power BI, Tableau, Python, SAP.
Education: BSc Economics. Languages: English, Portuguese.`

const CV_ENG = `Dan Okonkwo
Senior Software Engineer. 8 years of experience.
Staff Engineer (2022-present): TypeScript, Node.js, React, AWS, PostgreSQL, GraphQL, Kubernetes, Terraform.
Software Engineer (2018-2022): Node.js, TypeScript, React, PostgreSQL, AWS.
Skills: TypeScript, JavaScript, Node.js, React, GraphQL, PostgreSQL, AWS, Kubernetes, Terraform, Docker, CI/CD.
Education: BSc Computer Science. Remote from Berlin.`

export 
const CV_DATA = `Priya Raman
Data Analyst / BI Analyst. 5 years of experience.
Data Analyst (2021-present, e-commerce): SQL over the warehouse, Tableau dashboards, weekly KPI reporting, A/B test analysis.
BI Analyst (2019-2021, marketplace): Power BI semantic models, dbt pipelines, data quality checks, stakeholder reporting.
Reporting Analyst (2018-2019, retail): Excel, Power BI, monthly reporting packs.
Skills: SQL, Python, Tableau, Power BI, dbt, statistics, A/B testing, data modelling, Excel.
Tools: SQL, Python, Tableau, Power BI, dbt, Airflow, Snowflake.
Education: MSc Statistics.`

export interface Case {
  id: string
  label: Label
  note: string
  cv: string
  title: string
  description: string
  requirements?: string | null
  location?: string | null
}

export const CASES: Case[] = [
  // ---------------------------------------------------------------- matches
  {
    id: 'fin-01', label: 'match', note: 'same function, same sector',
    cv: CV_FINANCE, title: 'Financial Analyst, Reporting',
    description: `We are hiring a Financial Analyst to join our group reporting team.
You will own the monthly close pack, variance analysis and forecast submission for three business units, and keep the IFRS reporting deliverables on schedule.
Requirements: 3+ years in a finance function, advanced Excel, IFRS reporting experience, financial modelling. SQL is a plus.
You will partner with the commercial teams and support planning cycles and governance reviews.`,
    location: 'Lisbon, PT'
  },
  {
    id: 'fin-02', label: 'match', note: 'same function, senior stretch',
    cv: CV_FINANCE, title: 'Senior Financial Analyst (FP&A)',
    description: `FP&A team is looking for a Senior Financial Analyst to run budgeting, forecasting and monthly variance reviews.
About the role: build the rolling forecast, own the budget model, run the monthly pack with the controllers.
Required qualifications: 5+ years of experience in FP&A or financial planning, advanced Excel, financial modelling, variance analysis. Power BI experience required.
Preferred: SQL, exposure to SaaS metrics (ARR, NRR).`,
    location: 'Remote (EU)'
  },
  {
    id: 'fin-03', label: 'match', note: 'same profession, data side of finance',
    cv: CV_FINANCE, title: 'Data Analyst, Finance',
    description: `As Data Analyst you will build and maintain the reporting layer used by the finance leadership.
Responsibilities: write SQL against the warehouse, maintain Tableau dashboards, define and report the monthly financial KPIs.
Must have: 2+ years in data analysis, SQL, Tableau or Power BI, experience with financial or commercial data. Excel for validation.
Nice to have: Python, financial modelling basics.`,
    location: 'Porto, PT'
  },
  {
    id: 'fin-04', label: 'match', note: 'revenue/metrics analyst, SaaS',
    cv: CV_FINANCE, title: 'Revenue Analyst',
    description: `We need a Revenue Analyst to own our revenue metrics and pricing analysis.
You will track ARR, NRR and churn, build the pricing models, and report variance to the leadership team every month.
Requirements: 3+ years in revenue analytics or commercial finance, advanced Excel, SQL, financial modelling. Experience in a SaaS company is a plus.`,
    location: 'Remote'
  },
  {
    id: 'fin-05', label: 'match', note: 'credit risk in a bank: sector match',
    cv: CV_FINANCE, title: 'Credit Risk Analyst',
    description: `The credit risk team is hiring an analyst to monitor our corporate portfolio.
Responsibilities: risk rating of counterparties, IFRS 9 provisioning models, portfolio monitoring, regular reporting to the risk committee.
Required: 3+ years in credit risk, risk management or financial analysis, financial modelling, IFRS reporting, advanced Excel. SQL is a plus.`,
    location: 'Lisbon, PT'
  },
  {
    id: 'fin-06', label: 'match', note: 'BI role scoped to finance',
    cv: CV_FINANCE, title: 'Business Intelligence Analyst — Finance',
    description: `As BI Analyst you will build the finance reporting layer: dashboards, semantic models and the monthly reporting pipeline.
Requirements: SQL, Power BI, dimensional modelling, experience presenting financial KPIs to stakeholders. Financial reporting knowledge required.
You will work closely with the finance analysts and the data engineering team.`,
    location: 'Remote (EU)'
  },
  {
    id: 'fin-07', label: 'match', note: 'commercial finance',
    cv: CV_FINANCE, title: 'Commercial Finance Analyst',
    description: `Commercial finance is hiring an analyst to support pricing and revenue decisions.
You will build the pricing analysis models, run the monthly commercial review, and maintain the profitability reporting.
Required: 2+ years in commercial finance, pricing analysis, financial modelling, Excel, variance analysis. SQL exposure required.`,
    location: 'Braga, PT'
  },
  {
    id: 'fin-08', label: 'match', note: 'IFRS/GAAP reporting, remote',
    cv: CV_FINANCE, title: 'Financial Reporting Analyst',
    description: `We are looking for a Financial Reporting Analyst to support the group reporting cycle under IFRS.
Responsibilities: statutory reporting, consolidation support, audit support, variance analysis on the reported numbers.
Requirements: 3+ years of reporting experience, IFRS, financial statements, advanced Excel, financial modelling. English working proficiency.`,
    location: 'Remote (EMEA)'
  },
  {
    id: 'fin-09', label: 'match', note: 'pricing analyst, forecasting',
    cv: CV_FINANCE, title: 'Pricing Analyst',
    description: `Our pricing team needs an analyst to turn commercial data into pricing decisions.
You will own the pricing models, run scenario analysis, and report the impact on revenue and margin.
Required qualifications: 2+ years in pricing or commercial analytics, financial modelling, forecasting, SQL, Excel. Power BI for reporting.`,
    location: 'Lisbon, PT'
  },
  {
    id: 'fin-10', label: 'match', note: 'junior posting, same function',
    cv: CV_FINANCE, title: 'Junior Financial Analyst',
    description: `We are hiring a Junior Financial Analyst to support the reporting team.
You will help with the monthly pack, variance analysis and forecast updates under the guidance of a senior analyst.
Requirements: 1+ year of experience or a strong finance internship, Excel, financial reporting basics, IFRS exposure. SQL optional.`,
    location: 'Porto, PT'
  },
  {
    id: 'fin-11', label: 'match', note: 'quant-ish analytics on financial data',
    cv: CV_FINANCE, title: 'Financial Data Analyst — Risk Reporting',
    description: `Risk reporting is hiring a data analyst to own the regulatory reporting pipeline.
Responsibilities: SQL extraction for the risk reports, building the reporting warehouse models, automating the IFRS disclosures.
Requirements: 3+ years, SQL, Python, financial reporting, risk or regulatory reporting, Excel. Tableau required.`,
    location: 'Remote'
  },
  // ----------------------------------------------------------------- nears
  {
    id: 'near-01', label: 'near', note: 'same profession, other sector',
    cv: CV_FINANCE, title: 'Data Analyst (Product)',
    description: `Product team is hiring a Data Analyst to instrument the product.
You will write SQL, run A/B tests, build dashboards in Amplitude and analyse retention funnels.
Requirements: 2+ years in product or growth analytics, SQL, Python, experimentation, statistics. Dashboarding tools.`,
    location: 'Remote'
  },
  {
    id: 'near-02', label: 'near', note: 'finance-adjacent, heavier math',
    cv: CV_FINANCE, title: 'Quantitative Analyst — Model Validation',
    description: `Model validation is hiring a quant to independently review our pricing and risk models.
Responsibilities: statistical validation of models, sensitivity analysis, writing model documentation, challenging assumptions.
Requirements: 4+ years, probability and statistics, stochastic modelling, Python, SQL. Finance background required.`,
    location: 'Lisbon, PT'
  },
  {
    id: 'near-03', label: 'near', note: 'management stretch, same function',
    cv: CV_FINANCE, title: 'FP&A Manager',
    description: `We are hiring an FP&A Manager to lead a team of three analysts.
Responsibilities: own the budget and rolling forecast, lead the monthly reporting cycle, coach the analysts, own the board pack.
Requirements: 7+ years in FP&A, team leadership, financial modelling, variance analysis, advanced Excel. Experience with board reporting.`,
    location: 'Lisbon, PT'
  },
  {
    id: 'near-04', label: 'near', note: 'equity research, different market knowledge',
    cv: CV_FINANCE, title: 'Investment Analyst, Equity Research',
    description: `Our research team covers Iberian financials. We are hiring an Investment Analyst to write research on listed companies.
Responsibilities: build financial models for listed names, forecast earnings, write research notes, talk to company management.
Requirements: 3+ years in equity research, financial modelling, valuation, financial statements, Excel. Portuguese and English required.`,
    location: 'Madrid, ES'
  },
  {
    id: 'near-05', label: 'near', note: 'seniority stretch: 12+ years asked',
    cv: CV_FINANCE, title: 'Senior Financial Analyst (12+ years)',
    description: `Our group finance team is hiring a Senior Financial Analyst to lead the reporting for two divisions.
Responsibilities: monthly close, forecast, variance analysis, IFRS reporting, review the work of two junior analysts.
Required: 12+ years of experience in group financial reporting, IFRS, financial modelling, advanced Excel, leadership of junior staff.`,
    location: 'Remote (EU)'
  },
  {
    id: 'near-06', label: 'near', note: 'accounting adjacent, no licence demanded',
    cv: CV_FINANCE, title: 'Senior Accountant',
    description: `We are hiring a Senior Accountant to run the statutory accounts for two entities.
Responsibilities: statutory accounts, consolidation support, tax filings support, audit interface, monthly close.
Requirements: 5+ years of accounting experience, statutory accounts, IFRS, financial statements, advanced Excel. Audit experience required.`,
    location: 'Porto, PT'
  },
  {
    id: 'near-07', label: 'near', note: 'treasury: finance family, different function',
    cv: CV_FINANCE, title: 'Treasury Analyst',
    description: `Treasury is hiring an analyst to support cash forecasting and liquidity management.
Responsibilities: daily cash position, 13-week cash flow forecast, bank exposure monitoring, FX hedging support.
Requirements: 2+ years in treasury or corporate finance, financial modelling, forecasting, Excel. SQL for reporting.`,
    location: 'Lisbon, PT'
  },
  {
    id: 'near-08', label: 'near', note: 'software role, CV has Python+SQL only',
    cv: CV_FINANCE, title: 'Data Engineer',
    description: `We need a Data Engineer to build the pipelines feeding our finance warehouse.
Responsibilities: build batch and streaming pipelines, maintain the transformation layer, data quality, orchestration.
Requirements: 3+ years, Python, Spark, Airflow, SQL, data modelling, cloud storage. Git, Docker.`,
    location: 'Remote'
  },
  // ---------------------------------------------------------------- misses
  {
    id: 'miss-01', label: 'miss', note: 'marketing, shares only soft/office words',
    cv: CV_FINANCE, title: 'Marketing Manager',
    description: `We are looking for a Marketing Manager to own our brand and demand generation.
Responsibilities: run the campaign calendar across SEO, SEM and social, manage the agency relationship, report on pipeline and awareness.
Requirements: 5+ years in marketing, campaign management, SEO, content marketing, brand, analytics reporting. Team management.`,
    location: 'Lisbon, PT'
  },
  {
    id: 'miss-02', label: 'miss', note: 'sales, no finance content',
    cv: CV_FINANCE, title: 'Sales Development Representative',
    description: `Join our outbound SDR team. You will prospect into fintech accounts, run outbound sequences, book meetings for AEs and hit your weekly activity numbers.
Requirements: 1+ years in sales or BDR, outbound, CRM, communication skills. Targets and pipeline ownership.`,
    location: 'Remote'
  },
  {
    id: 'miss-03', label: 'miss', note: 'HR, generic "analyst"-free posting',
    cv: CV_FINANCE, title: 'HR Business Partner',
    description: `As HRBP you will advise two business units on people matters: employee relations, performance management, headcount planning and policy.
Requirements: 5+ years in HR, employee relations, performance management, labour law, works council experience.`,
    location: 'Porto, PT'
  },
  {
    id: 'miss-04', label: 'miss', note: 'logistics ops',
    cv: CV_FINANCE, title: 'Operations Manager, Warehouse',
    description: `You will run our distribution centre: inbound and outbound, fleet of forklifts, stock accuracy, health and safety, shift planning.
Requirements: 5+ years in warehouse operations, logistics, WMS, lean, fleet management, shift leadership.`,
    location: 'Setubal, PT'
  },
  {
    id: 'miss-05', label: 'miss', note: 'UX research',
    cv: CV_FINANCE, title: 'UX Researcher',
    description: `We need a UX Researcher to run our generative and evaluative research programme: interviews, usability testing, surveys, and a research repository.
Requirements: 4+ years in UX research, interviews, usability testing, survey design, qualitative analysis.`,
    location: 'Remote'
  },
  {
    id: 'miss-06', label: 'miss', note: 'mechanical engineering',
    cv: CV_FINANCE, title: 'Mechanical Engineer',
    description: `Our plant team is hiring a Mechanical Engineer to own the maintenance and reliability of the production line.
Responsibilities: preventive maintenance, root cause analysis, equipment specs, project works with the maintenance contractor.
Requirements: 4+ years as a mechanical engineer, CAD, maintenance planning, industrial equipment, safety standards.`,
    location: 'Porto, PT'
  },
  {
    id: 'miss-07', label: 'miss', note: 'content marketing, heavy keyword noise',
    cv: CV_FINANCE, title: 'Content Marketing Specialist',
    description: `You will write and distribute content: blog posts, landing pages, newsletters and case studies. You will run SEO reporting and hand off reporting to the business team.
Requirements: 3+ years in content marketing, SEO, copywriting, analytics, WordPress, campaign reporting.`,
    location: 'Remote'
  },
  {
    id: 'miss-08', label: 'miss', note: 'civil engineering',
    cv: CV_FINANCE, title: 'Civil Engineer — Infrastructure',
    description: `We are recruiting a Civil Engineer for the design and delivery of urban infrastructure projects: site supervision, technical drawings, contractor management, compliance with the code.
Requirements: 5+ years as a civil engineer, AutoCAD, site supervision, structural design, public procurement.`,
    location: 'Lisbon, PT'
  },
  {
    id: 'miss-09', label: 'miss', note: 'account executive',
    cv: CV_FINANCE, title: 'Account Executive, SaaS',
    description: `Own the full sales cycle for mid-market accounts: discovery, proposals, negotiation, closing. You will carry a quota and renewals.
Requirements: 4+ years closing B2B software deals, quota attainment, pipeline management, negotiation, CRM.`,
    location: 'Remote'
  },
  {
    id: 'miss-10', label: 'miss', note: 'teacher',
    cv: CV_FINANCE, title: 'Primary School Teacher',
    description: `We are hiring a Primary School Teacher for the 2026/27 school year. You will plan lessons, deliver the national curriculum, assess pupils and report to parents at conferences.
Requirements: degree in education, classroom experience, curriculum planning, safeguarding, student assessment.`,
    location: 'Porto, PT'
  },
  // ---------------------------------------------------------------- blocks
  {
    id: 'blk-01', label: 'block', note: 'nursing licence absent from CV',
    cv: CV_FINANCE, title: 'Registered Nurse — ICU',
    description: `Our intensive care unit is hiring a Registered Nurse on a rotational contract.
Responsibilities: administer medication, monitor vital signs, ventilator management, patient records, handovers with the medical team.
Requirements: active RN licence, 3+ years in an acute setting, BLS and ACLS certification, electronic patient records.`,
    location: 'Lisbon, PT'
  },
  {
    id: 'blk-02', label: 'block', note: 'medical licence absent from CV',
    cv: CV_FINANCE, title: 'Staff Physician, Internal Medicine',
    description: `We are hiring a Staff Physician for our internal medicine service: ward rounds, outpatient clinic, teaching of residents, on-call.
Requirements: medical licence in good standing, MD, board certification in internal medicine, 6+ years of clinical practice, hospital experience.`,
    location: 'Porto, PT'
  },
  {
    id: 'blk-03', label: 'block', note: 'chartered accountant licence, no ACA/CPA',
    cv: CV_FINANCE, title: 'Chartered Accountant — Audit, ICAEW',
    description: `Our audit practice is hiring a Chartered Accountant. You will lead audit engagements from planning to completion, supervise the team and sign off the audit opinion.
Requirements: ACA or ICAEW qualified chartered accountant, 5+ years in audit, IFRS and ISA knowledge, audit software, statutory reporting.`,
    location: 'London, UK'
  },
  {
    id: 'blk-04', label: 'block', note: 'securities registration absent from CV',
    cv: CV_FINANCE, title: 'Registered Securities Representative',
    description: `As an RSR you will advise retail clients on our brokerage platform, process account opening, and communicate market information.
Requirements: Series 7 and Series 63 registration, FINRA exams passed, 2+ years in a brokerage, customer-facing communication, trading platform experience.`,
    location: 'New York, US'
  },
  {
    id: 'blk-05', label: 'block', note: 'CFA charter absent from CV',
    cv: CV_FINANCE, title: 'CFA Level III Portfolio Manager',
    description: `We are hiring a Portfolio Manager to run a USD 400m global equity mandate.
Requirements: CFA Level III (charter holder) required, 8+ years in asset management, equity research background, performance attribution, risk management.`,
    location: 'Frankfurt, DE'
  },
  {
    id: 'blk-06', label: 'block', note: 'bar admission, legal practice',
    cv: CV_FINANCE, title: 'Associate Attorney — Corporate Law',
    description: `Our corporate practice is hiring an Associate to work on M&A, shareholder agreements and due diligence.
Requirements: JD and bar admission, 2+ years of corporate law experience, contract drafting, due diligence, excellent English. Portuguese a plus.`,
    location: 'Lisbon, PT'
  },
  {
    id: 'blk-07', label: 'block', note: 'pharmacy licence absent from CV',
    cv: CV_FINANCE, title: 'Staff Pharmacist',
    description: `Our central pharmacy is hiring a Staff Pharmacist: dispensing review, clinical checks, stock control, medicines information queries.
Requirements: PharmD, RPh registration, 4+ years in a hospital or community pharmacy, medicines information, clinical governance.`,
    location: 'Porto, PT'
  },
  {
    id: 'blk-08', label: 'block', note: 'regulated trade, no field-services background',
    cv: CV_FINANCE, title: 'Electrician — Commercial Maintenance',
    description: `We need an Electrician for planned and reactive maintenance across our commercial sites: fault finding, installation, testing certificates.
Requirements: certified electrician licence, 3+ years commercial maintenance, 18th edition certification, driving licence, own tools.`,
    location: 'Setubal, PT'
  },
  {
    id: 'blk-09', label: 'block', note: 'psychology licence, regulated clinical domain',
    cv: CV_FINANCE, title: 'Clinical Psychologist (Licensed, PsyD)',
    description: `Our mental health service is hiring a Clinical Psychologist to deliver assessment and therapy for adults in our outpatient service.
Requirements: PsyD in clinical psychology, licensed to practise, 5+ years post-qualification experience, CBT, assessment, supervision.`,
    location: 'Remote'
  },
  // ------------------------------------------- third CV: data/BI analyst
  {
    id: 'dat-01', label: 'match', note: 'data CV, data-side of finance',
    cv: CV_DATA, title: 'Data Analyst — Finance',
    description: `The finance data team is hiring a Data Analyst to own the reporting used by the CFO.
Responsibilities: SQL extraction, monthly financial reporting, variance dashboards, self-service BI for the finance analysts.
Required: 3+ years in data analysis, SQL, Tableau or Power BI, financial or commercial data, statistics. Python required.`,
    location: 'Remote (EU)'
  },
  {
    id: 'dat-02', label: 'near', note: 'the same-family case: a financial analyst role for a data-only CV',
    cv: CV_DATA, title: 'Financial Analyst, Group Reporting',
    description: `Group reporting is hiring a Financial Analyst to own the monthly pack.
Responsibilities: IFRS financial statements, monthly close, consolidation support, variance analysis, audit support, financial modelling.
Required: 4+ years in financial reporting, IFRS, financial statements, variance analysis, advanced Excel, financial modelling.`,
    location: 'Remote (EU)'
  },
  {
    id: 'dat-03', label: 'miss', note: 'data CV, sales role',
    cv: CV_DATA, title: 'Account Executive, Mid-Market',
    description: `Own the full sales cycle for mid-market accounts: discovery, proposals, negotiation, closing. Quota and pipeline ownership.
Requirements: 4+ years closing B2B deals, quota attainment, pipeline management, negotiation, CRM.`,
    location: 'Remote'
  },
  {
    id: 'dat-04', label: 'block', note: 'data CV, licensed clinical role',
    cv: CV_DATA, title: 'Registered Nurse — Emergency Department',
    description: `Our emergency department is hiring a Registered Nurse on a rotational contract: medication administration, vital signs, triage, patient records, handovers.
Requirements: active RN licence, 3+ years in an acute setting, BLS and ACLS certification, electronic patient records.`,
    location: 'Remote'
  },
  // ------------------------------------------------- second CV (anti-tuning)
  {
    id: 'eng-01', label: 'match', note: 'eng CV, engineering match',
    cv: CV_ENG, title: 'Senior Backend Engineer (Node/TypeScript)',
    description: `We are hiring a Senior Backend Engineer for the payments platform team.
Requirements: 5+ years, TypeScript, Node.js, PostgreSQL, API design, AWS. REST, testing, code review. GraphQL required.
You will design services, review code and mentor two mid-level engineers.`,
    location: 'Berlin, DE'
  },
  {
    id: 'eng-02', label: 'match', note: 'eng CV, platform match',
    cv: CV_ENG, title: 'Platform Engineer (Kubernetes/Terraform)',
    description: `Platform engineering is hiring to own our Kubernetes platform and the delivery toolchain.
Requirements: 4+ years, Kubernetes, Terraform, AWS, Docker, CI/CD, observability, Linux. Infrastructure as code is a must.`,
    location: 'Remote (EU)'
  },
  {
    id: 'eng-03', label: 'near', note: 'eng CV, data platform pull',
    cv: CV_ENG, title: 'Data Platform Engineer',
    description: `We need a Data Platform Engineer to build Spark and Airflow pipelines on the cloud.
Requirements: 3+ years, Python, Spark, Airflow, SQL, data modelling, cloud data warehouses. Streaming experience required.`,
    location: 'Berlin, DE'
  },
  {
    id: 'eng-04', label: 'near', note: 'eng CV, management stretch',
    cv: CV_ENG, title: 'Engineering Manager, Payments',
    description: `As Engineering Manager you will lead a team of 8 engineers delivering the payments domain: delivery, hiring, performance, architecture.
Requirements: 8+ years of engineering experience, 2+ years managing engineers, TypeScript/Node.js background, delivery ownership.`,
    location: 'Berlin, DE'
  },
  {
    id: 'eng-05', label: 'miss', note: 'eng CV, finance posting',
    cv: CV_ENG, title: 'Financial Analyst — Group Reporting',
    description: `Group reporting is hiring a Financial Analyst to own the monthly pack.
Requirements: 3+ years in finance, IFRS, financial statements, variance analysis, advanced Excel, financial modelling.`,
    location: 'Remote'
  },
  {
    id: 'eng-06', label: 'miss', note: 'eng CV, marketing posting',
    cv: CV_ENG, title: 'Growth Marketing Lead',
    description: `You will own paid acquisition and lifecycle marketing: spend, ROAS, campaigns, attribution, and the marketing automation stack.
Requirements: 5+ years in growth marketing, paid acquisition, SEO, attribution, marketing automation, analytics.`,
    location: 'Berlin, DE'
  },
  {
    id: 'eng-07', label: 'block', note: 'eng CV, licensed role',
    cv: CV_ENG, title: 'Pharmacist (RPh) — Night Shift',
    description: `Night shift pharmacist: dispensing review, clinical checks, medicines information, stock control.
Requirements: RPh registration, PharmD, 3+ years in pharmacy, clinical governance.`,
    location: 'Porto, PT'
  }
]

describe('fitHeuristic', () => {
  describe('extractTechnicalTerms', () => {
    it('finds known technical skills', () => {
      const terms = extractTechnicalTerms('Looking for React, TypeScript, AWS, and Kubernetes')
      expect(terms.has('react')).toBe(true)
      expect(terms.has('typescript')).toBe(true)
      expect(terms.has('aws')).toBe(true)
      expect(terms.has('kubernetes')).toBe(true)
      expect(terms.has('k8s')).toBe(true)
    })

    it('captures tokens with technical symbols', () => {
      const terms = extractTechnicalTerms('C++, C#, node.js, web3')
      expect(terms.has('c++')).toBe(true)
      expect(terms.has('c#')).toBe(true)
      expect(terms.has('node.js')).toBe(true)
      expect(terms.has('web3')).toBe(true)
    })

    it('ignores common stopwords', () => {
      const terms = extractTechnicalTerms('the and for are but not you all can')
      for (const t of terms) {
        expect(t.length).toBeGreaterThan(3)
      }
    })
  })

  describe('extractRoleTitles', () => {
    it('extracts role-looking lines', () => {
      const roles = extractRoleTitles('Senior Software Engineer\nI like pancakes\nProduct Manager')
      expect(roles).toHaveLength(2)
      expect(roles[0]).toContain('engineer')
      expect(roles[1]).toContain('manager')
    })
  })

  describe('extractYearsExperience', () => {
    it('extracts required years', () => {
      expect(extractYearsExperience('5+ years of experience')).toBe(5)
      expect(extractYearsExperience('Requires 3-5 years experience')).toBe(5)
      expect(extractYearsExperience('2 yrs of relevant work')).toBe(2)
    })

    it('returns 0 when no years are present', () => {
      expect(extractYearsExperience('Entry level position')).toBe(0)
    })
  })

  describe('extractEducationLevel', () => {
    it('orders education correctly', () => {
      expect(extractEducationLevel('Bachelor degree required')).toBe(3)
      expect(extractEducationLevel('Masters in CS')).toBe(4)
      expect(extractEducationLevel('PhD in Machine Learning')).toBe(5)
      expect(extractEducationLevel('No education requirement')).toBe(0)
    })
  })

  describe('scoreCompatibility (legacy wrapper)', () => {
    const baseCv = `
      Senior Software Engineer with 6 years of experience.
      Skills: React, TypeScript, Node.js, AWS, PostgreSQL.
      Interested in remote senior engineer roles.
    `

    it('returns a strong score for a matching senior engineer role', () => {
      const title = 'Senior Software Engineer'
      const desc = 'React, TypeScript, Node.js, AWS. 5+ years experience. Remote.'
      const score = scoreCompatibility(title, desc, baseCv)
      expect(score).toBeGreaterThanOrEqual(0.7)
    })

    it('returns a lower score for an unrelated job', () => {
      const title = 'Veterinary Technician'
      const desc = 'Animal care, surgery assistance, clinic work.'
      const score = scoreCompatibility(title, desc, baseCv)
      expect(score).toBeLessThan(0.5)
    })

    it('returns a neutral score when no CV is provided', () => {
      expect(scoreCompatibility('Engineer', 'React', '')).toBe(0.5)
    })
  })

  describe('scoreCompatibilityStructured', () => {
    const baseCv = `
      Staff Software Engineer with 8 years of experience.
      Expert in TypeScript, React, Node.js, AWS, PostgreSQL, GraphQL.
      Remote worker based in Seattle.
      Education: Bachelor of Science in Computer Science.
    `

    it('ignores location (it is not a relevance signal)', () => {
      const title = 'Senior Software Engineer'
      const desc = 'React, TypeScript, AWS. 5+ years experience.'
      const withoutLoc = scoreCompatibilityStructured({ title, description: desc, requirements: null, location: null, baseCv })
      const withLoc = scoreCompatibilityStructured({ title, description: desc, requirements: null, location: 'Seattle, WA', baseCv })
      expect(withLoc).toBeGreaterThanOrEqual(withoutLoc)
    })

    it('gives a high score for a strong full-stack remote role', () => {
      const title = 'Senior Full-Stack Engineer'
      const desc = 'React, TypeScript, Node.js, AWS, PostgreSQL, GraphQL. 5+ years.'
      const score = scoreCompatibilityStructured({ title, description: desc, requirements: null, location: 'Remote', baseCv })
      expect(score).toBeGreaterThanOrEqual(0.75)
    })

    it('penalizes missing hard requirements', () => {
      const title = 'Rust Systems Engineer'
      const desc = 'Rust, Kubernetes, distributed systems. 8+ years required.'
      const score = scoreCompatibilityStructured({ title, description: desc, requirements: null, location: 'Remote', baseCv })
      expect(score).toBeLessThan(0.75)
    })

    it('uses explicit requirements section for stronger signal', () => {
      const title = 'Frontend Engineer'
      const desc = 'Build UI components.'
      const requirements = 'Required: React, TypeScript. Preferred: Tailwind CSS.'
      const score = scoreCompatibilityStructured({
        title,
        description: desc,
        requirements,
        location: null,
        baseCv
      })
      expect(score).toBeGreaterThanOrEqual(0.5)
    })

    it('caps score at 1.0', () => {
      const score = scoreCompatibilityStructured({
        title: 'Senior TypeScript React Node.js AWS PostgreSQL GraphQL Engineer',
        description: 'React TypeScript Node.js AWS PostgreSQL GraphQL. 5+ years. Remote.',
        requirements: null,
        location: 'Seattle, WA',
        baseCv
      })
      expect(score).toBeLessThanOrEqual(1)
      expect(score).toBeGreaterThanOrEqual(0.75)
    })
  })
})

// ==== fixture-driven relevance bands =======================================

const MIN_MATCH = 0.45
const SCAN_FLOOR = 0.25
const MIN_NEAR = 0.1
const MAX_BLOCKED = 0.15

function scoreOf(c: Case) {
  return compatibilitySignals({
    title: c.title,
    description: c.description,
    requirements: c.requirements ?? null,
    location: c.location ?? null,
    baseCv: c.cv
  })
}

// The scan path calls scoreCompatibility(title, desc, baseCv): no location and
// no separate requirements field. The fixture is banded on that path, because
// that is the path the floor is applied on.
function scanScoreOf(c: Case): number {
  return scoreCompatibility(c.title, c.description, c.cv)
}

describe('labelled fixture set', () => {
  it('covers every band with at least 20 labelled postings', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20)
    const counts = { match: 0, near: 0, miss: 0, block: 0 }
    for (const c of CASES) counts[c.label]++
    expect(counts.match).toBeGreaterThanOrEqual(5)
    expect(counts.near).toBeGreaterThanOrEqual(5)
    expect(counts.miss).toBeGreaterThanOrEqual(5)
    expect(counts.block).toBeGreaterThanOrEqual(3)
  })

  it.each(CASES.map((c) => [c.id, c.label, c] as const))('%s (%s) lands in its band', (_id, _label, c) => {
    const score = scanScoreOf(c)
    if (c.label === 'match') expect(score, c.title).toBeGreaterThanOrEqual(MIN_MATCH)
    // The near band is deliberately wide and its floor is deliberately low: two
    // software/data postings and the same-family financial case are read as
    // out-of-sector for a finance or software CV, and land at 0.12-0.25. The
    // bias is towards the user's complaint (too much noise), not away from it.
    else if (c.label === 'near') expect(score, c.title).toBeGreaterThanOrEqual(MIN_NEAR)
    else if (c.label === 'miss') expect(score, c.title).toBeLessThan(SCAN_FLOOR)
    else expect(score, c.title).toBeLessThanOrEqual(MAX_BLOCKED)
  })

  it('separates clear matches from clear non-matches with a wide gap', () => {
    const matches = CASES.filter((c) => c.label === 'match').map(scanScoreOf)
    const misses = CASES.filter((c) => c.label === 'miss').map(scanScoreOf)
    const worstMatch = Math.min(...matches)
    const bestMiss = Math.max(...misses)
    // No clear match may be a weak signal, no clear non-match may reach the
    // scan floor, and a threshold has to fit between them.
    expect(worstMatch).toBeGreaterThanOrEqual(MIN_MATCH)
    expect(bestMiss).toBeLessThan(SCAN_FLOOR)
    expect(worstMatch - bestMiss).toBeGreaterThan(0.25)
  })

  it('keeps every near-miss above every clear non-match', () => {
    const nears = CASES.filter((c) => c.label === 'near').map(scanScoreOf)
    const misses = CASES.filter((c) => c.label === 'miss').map(scanScoreOf)
    expect(Math.min(...nears)).toBeGreaterThan(Math.max(...misses))
  })

  it('never lets a hard incompatibility reach the near band', () => {
    for (const c of CASES.filter((x) => x.label === 'block')) {
      const signals = scoreOf(c)
      if (signals.licenceGates.length === 0) continue
      expect(signals.score, c.id).toBeLessThanOrEqual(MAX_BLOCKED)
    }
  })

  it('agrees with itself on the structured path and the scan wrapper', () => {
    // The two paths differ only in that the wrapper drops location and the
    // requirements field; a posting with no separate requirements block must
    // score identically on both.
    for (const c of CASES) {
      if (c.requirements) continue
      expect(scanScoreOf(c), c.id).toBeCloseTo(scoreOf(c).score, 10)
    }
  })
})

describe('hard incompatibilities', () => {
  const nursing = {
    title: 'Registered Nurse — ICU',
    description: 'Intensive care unit hiring a nurse. Requirements: active RN licence, 3+ years in an acute setting, BLS certification, patient records.',
    requirements: null,
    location: null,
    baseCv: CV_FINANCE
  }

  it('caps a role gated by a licence the CV cannot evidence', () => {
    const signals = compatibilitySignals(nursing)
    expect(signals.licenceGates).toContain('nursing')
    expect(signals.score).toBeLessThanOrEqual(LICENCE_GATED_SCORE_CAP)
  })

  it('does not cap when the CV evidences the credential', () => {
    const signals = compatibilitySignals({
      ...nursing,
      baseCv: `${CV_FINANCE}\nRegistered Nurse, active RN licence.`
    })
    expect(signals.licenceGates).not.toContain('nursing')
    expect(signals.score).toBeGreaterThan(LICENCE_GATED_SCORE_CAP)
  })

  it('does not cap on a credential the posting only prefers', () => {
    const signals = compatibilitySignals({
      ...nursing,
      title: 'Critical Care Nurse — ICU',
      description: 'Intensive care unit. Requirements: 3+ years in an acute setting. Preferred: active RN licence, BLS certification.'
    })
    expect(signals.licenceGates).not.toContain('nursing')
  })

  it('does not cap on a credential the posting says it will fund', () => {
    const signals = compatibilitySignals({
      ...nursing,
      title: 'Critical Care Nurse — ICU',
      description: 'Intensive care unit. Requirements: 3+ years in an acute setting. We will fund your RN licence and BLS certification.'
    })
    expect(signals.licenceGates).not.toContain('nursing')
  })

  it('does not cap on "or equivalent experience"', () => {
    const signals = compatibilitySignals({
      ...nursing,
      title: 'Critical Care Nurse — ICU',
      description: 'Intensive care unit. Requirements: active RN licence or equivalent experience, 3+ years in an acute setting.'
    })
    expect(signals.licenceGates).not.toContain('nursing')
  })

  it('caps a regulated profession even when the skills line up', () => {
    const signals = compatibilitySignals({
      title: 'Chartered Accountant — Audit',
      description: 'Lead audit engagements. Requirements: ICAEW qualified chartered accountant, 5+ years in audit, IFRS and ISA knowledge, audit software.',
      requirements: null,
      location: null,
      baseCv: 'Senior Accountant, 12 years of experience. Audit, IFRS financial statements, consolidation, tax, statutory accounts, financial modelling, Excel.'
    })
    expect(signals.licenceGates).toContain('accounting-licence')
    // Every requirement the posting states is one the CV has; the licence is
    // still what has to decide the outcome.
    expect(signals.missing).toEqual([])
    expect(signals.skills).toBeGreaterThanOrEqual(0.5)
    expect(signals.score).toBeLessThanOrEqual(LICENCE_GATED_SCORE_CAP)
  })
})

describe('role: profession and branch', () => {
  it('separates a financial-analyst role from a data-analyst role for the same person', () => {
    const dataRole = compatibilitySignals({
      title: 'Data Analyst — Finance',
      description: 'Own the finance reporting. Requirements: SQL, Tableau, Power BI, statistics, financial data.',
      requirements: null,
      location: null,
      baseCv: CV_DATA
    })
    const financialRole = compatibilitySignals({
      title: 'Financial Analyst, Group Reporting',
      description: 'Own the monthly pack. Requirements: IFRS financial statements, consolidation, variance analysis, financial modelling, Excel.',
      requirements: null,
      location: null,
      baseCv: CV_DATA
    })
    // Same profession word ("analyst") in both titles. The branch is what
    // separates them, and the branch is the difference the candidate cares
    // about.
    expect(dataRole.role).toBe(1)
    expect(financialRole.role).toBe(0.5)
    expect(dataRole.score).toBeGreaterThan(financialRole.score + 0.2)
  })

  it('does not call a nurse a data analyst', () => {
    const signals = compatibilitySignals({
      title: 'Registered Nurse — Emergency Department',
      description: 'Triage, medication administration, vital signs, patient records. Requirements: RN licence.',
      requirements: null,
      location: null,
      baseCv: CV_FINANCE
    })
    expect(signals.role).toBe(0)
    expect(signals.sector).toBe(0)
    expect(signals.score).toBeLessThan(0.1)
  })

  it('does not read a shared function word as a shared profession', () => {
    // The old word-overlap role score returned 1.0 here: the CV line "Data
    // Analyst (2018-2019, operations): SQL over the warehouse" shares both
    // "operations" and "warehouse" with this title, and the posting went on to
    // be the highest-scoring non-match in the fixture set (0.79).
    const signals = compatibilitySignals({
      title: 'Operations Manager, Warehouse',
      description: 'Run the distribution centre: inbound and outbound, fleet of forklifts, stock accuracy, shift planning. Requirements: 5+ years in warehouse operations, WMS, lean.',
      requirements: null,
      location: null,
      baseCv: CV_FINANCE
    })
    expect(signals.score).toBeLessThan(SCAN_FLOOR)
  })

  it('reports an unreadable profession as unmeasured, not as a mismatch', () => {
    // "Summer Intern" names no profession, so the profession signal has
    // nothing to say about it, and must not count as evidence either way.
    const signals = compatibilitySignals({
      title: 'Summer Intern',
      description: 'Great opportunity to learn. Apply now.',
      requirements: null,
      location: null,
      baseCv: CV_FINANCE
    })
    expect(signals.role).toBeNull()
  })
})

describe('absence of a signal is a mismatch, not a neutral', () => {
  it('scores a posting with nothing comparable as 0, not as neutral', () => {
    const signals = compatibilitySignals({
      title: 'Opportunity',
      description: 'Great company, competitive salary, apply now.',
      requirements: null,
      location: null,
      baseCv: CV_FINANCE
    })
    expect(signals.score).toBe(0)
  })

  it('does not pay a senior candidate for a senior title in the wrong field', () => {
    // A 20-year CV against a 5-year logistics job. The old scorer handed out
    // 0.20 here purely from the seniority and location priors — and gave every
    // unrelated posting in the fixture set exactly 0.20 for the same reason,
    // which is how neutral-beats-weak-positive let noise in.
    const signals = compatibilitySignals({
      title: 'Operations Manager, Warehouse',
      description: 'Run the distribution centre: fleet of forklifts, stock accuracy, WMS, lean, shift planning. Requirements: 5+ years in warehouse operations.',
      requirements: null,
      location: null,
      baseCv: `${CV_FINANCE}\nAdditional: 20 years of experience across finance and analytics roles.`
    })
    expect(signals.score).toBeLessThan(SCAN_FLOOR)
  })

  it('is not fooled by generic office vocabulary in the posting', () => {
    for (const c of CASES.filter((x) => x.label === 'miss')) {
      expect(scanScoreOf(c), `${c.id} ${c.title}`).toBeLessThan(SCAN_FLOOR)
    }
  })
})

describe('seniority is a bounded preference', () => {
  const financeJob = (years: number) => ({
    title: 'Financial Analyst',
    description: `Monthly close, variance analysis, financial modelling, Excel. Requirements: ${years}+ years of experience in financial analysis.`,
    requirements: null,
    location: null,
    baseCv: CV_FINANCE
  })

  it('keeps a stretch role a lead rather than disqualifying it', () => {
    const stretch = compatibilitySignals(financeJob(15))
    expect(stretch.seniorityFactor).toBeGreaterThan(0.5)
    expect(stretch.score).toBeGreaterThanOrEqual(MIN_MATCH)
  })

  it('never discounts relevance by more than the stated floor', () => {
    expect(compatibilitySignals(financeJob(40)).seniorityFactor).toBeGreaterThanOrEqual(0.55)
  })

  it('gives no bonus for being over-qualified', () => {
    const easy = compatibilitySignals(financeJob(3))
    const exact = compatibilitySignals(financeJob(6))
    expect(exact.seniorityFactor).toBe(1)
    expect(easy.score).toBeLessThanOrEqual(exact.score + 0.02)
  })

  it('is a multiplier on relevance, not an additive term', () => {
    // Relevance is not what seniority changes; an unrelated posting stays at
    // 0 however senior the candidate is.
    const signals = compatibilitySignals({
      title: 'Primary School Teacher',
      description: 'Plan lessons, deliver the curriculum, assess pupils, parent conferences. Requirements: degree in education, classroom experience.',
      requirements: null,
      location: null,
      baseCv: `${CV_FINANCE}\nAdditional: 20 years of experience.`
    })
    expect(signals.score).toBe(0)
  })
})

describe('the score is legible', () => {
  it('exposes every term that produced it', () => {
    const signals = compatibilitySignals({
      title: 'Senior Financial Analyst (FP&A)',
      description: 'Budgeting, forecasting, variance analysis, financial modelling, Excel, Power BI, SQL. Requirements: 5+ years in FP&A.',
      requirements: null,
      location: 'Remote',
      baseCv: CV_FINANCE
    })
    expect(signals.skills).not.toBeNull()
    expect(signals.role).toBe(1)
    expect(signals.sector).not.toBeNull()
    expect(signals.seniorityFactor).toBeGreaterThan(0)
    // The CV says "financial modelling", the shared allowlist says "financial
    // modeling": the spelling table is what lets them meet.
    expect(signals.matched).toContain('financial modeling')
    expect(signals.score).toBeLessThanOrEqual(1)
  })

  it('does not count a title word as a skill requirement', () => {
    // "manager" is a role, measured by the role and seniority terms; counting
    // it again as a missing skill only dilutes the skill evidence.
    const signals = compatibilitySignals({
      title: 'Operations Manager, Warehouse',
      description: 'Run the distribution centre: fleet of forklifts, stock accuracy, WMS. Requirements: 5+ years in warehouse operations.',
      requirements: null,
      location: null,
      baseCv: CV_FINANCE
    })
    expect(signals.missing).not.toContain('manager')
  })
})

describe('location is not a relevance signal', () => {
  const job = {
    title: 'Financial Analyst, Reporting',
    description: 'Monthly close, IFRS statements, variance analysis, Excel, SQL. Requirements: 3+ years in financial analysis.',
    requirements: null,
    baseCv: CV_FINANCE
  }

  it('does not move the score', () => {
    const remote = scoreCompatibilityStructured({ ...job, location: 'Remote' })
    expect(scoreCompatibilityStructured({ ...job, location: 'Seattle, WA' })).toBe(remote)
    expect(scoreCompatibilityStructured({ ...job, location: 'Ulaanbaatar, MN' })).toBe(remote)
  })

  it('is the same on the scan path, which passes no location at all', () => {
    expect(scoreCompatibility(job.title, job.description, job.baseCv)).toBe(
      scoreCompatibilityStructured({ ...job, location: null })
    )
  })
})

describe('the no-CV prior', () => {
  it('is an explicit, exported constant rather than a literal in a return', () => {
    expect(NO_BASE_CV_SCORE).toBe(0.5)
    expect(scoreCompatibility('Engineer', 'React', '')).toBe(NO_BASE_CV_SCORE)
  })

  it('is reported as "nothing measured" rather than as a half match', () => {
    const signals = compatibilitySignals({
      title: 'Engineer',
      description: 'React',
      requirements: null,
      location: null,
      baseCv: ''
    })
    expect(signals.skills).toBeNull()
    expect(signals.role).toBeNull()
    expect(signals.sector).toBeNull()
    expect(signals.score).toBe(NO_BASE_CV_SCORE)
  })
})

describe('determinism', () => {
  it('returns the same score every time for the same input', () => {
    for (const c of CASES.slice(0, 20)) {
      const first = scanScoreOf(c)
      for (let i = 0; i < 5; i++) expect(scanScoreOf(c)).toBe(first)
    }
  })

  it('is independent of the order listings are scored in', () => {
    // The CV index is memoised with bounded eviction: scoring B between two
    // scorings of A must not change A's answer, and evicting A from the cache
    // must not change it either.
    const a = CASES[0]
    const aAlone = scanScoreOf(a)
    scanScoreOf(CASES[5])
    expect(scanScoreOf(a)).toBe(aAlone)
    for (const c of CASES) scanScoreOf(c)
    expect(scanScoreOf(a)).toBe(aAlone)
  })

  it('survives a churning cache without drifting', () => {
    const first = scanScoreOf(CASES[3])
    for (let i = 0; i < 40; i++) {
      scoreCompatibility('Financial Analyst', 'Excel, SQL, IFRS reporting', `CV number ${i} with SQL and Excel experience`)
    }
    expect(scanScoreOf(CASES[3])).toBe(first)
  })
})

/**
 * The scorer runs once per listing, thousands of times per scan, so it has to
 * stay cheap. Same synthetic 12k-word posting the keyword extractor is
 * guarded on, plus a guard on the size real postings actually are.
 *
 * Both guards below measure CPU and divide it by a fixed reference workload
 * measured in the same rounds, in the same process, interleaved with the work
 * under test. That ratio is the whole point, and everything else follows.
 *
 * The property worth guarding is "the scorer burns little CPU *for this
 * machine, right now*". Not "it returns within N ms of wall clock on whatever
 * machine happens to be running the suite", and not "it burns fewer than N ms
 * of CPU on every machine ever built". Both of those measure the machine at
 * least as much as the scorer: a worker descheduled by its siblings, a CI box
 * with something else on it, or a slow core all move the number without the
 * scorer changing at all.
 *
 * What a busy box does to a CPU measurement, measured with this guard on an
 * 8-core box (vitest 4.1.10, `maxWorkers = 4`, `availableParallelism() == 8`),
 * median of 5 repeats of 1000 scorings of a realistic posting:
 *
 *                     idle        light load    24 spinners   4 foreign workers
 *                     load 2.6    load 6-36     load ~35      load 40-80
 *     scan cpu        417-442ms   426-813ms     946-1023ms    935-1226ms
 *     reference       25.9-26.4   26.3-42.0     47.3-50.7     47.9-55.2
 *     scan/reference  16.2-16.3   16.2-20.2     18.9-21.5     19.3-23.1
 *
 * The raw CPU figure moves 2.9x across those conditions, so no fixed
 * millisecond budget can be a trip point on it. At the 1500ms of headroom
 * this branch settled on, a 3x-slowdown mutation *passed* when the box was
 * quiet -- 3.6x of trip point against a 3x regression -- and *failed* when it
 * was busy, where the same mutation measured 1723ms against the 1500ms budget.
 * The old guard was simultaneously too loose on a quiet box and prone to false
 * failure on a busy one, and the busiest condition measured is 1226ms of
 * *clean* scorer -- 1.2x of margin on correct code, one background GC spike
 * from failing on nothing. Dividing by a reference workload fixes the first
 * problem and creates the margin for the second: the normalised figure moves
 * 1.42x, not 2.9x.
 *
 * That direction is worth stating outright because the tempting next move at
 * the next flake is to add a retry, and this file did not have one to remove.
 * `REPEATS = 5` was five *measurements* whose minimum was taken, which is
 * fail-closed under load rather than fail-open: taking the best sample can
 * only understate the cost, never retry it into passing. There is no `retry`
 * anywhere in this repo's vitest config, and a probe test added to this tree to
 * check rather than assume recorded exactly one attempt for a failing
 * assertion. So the old guard's flakiness was never masking; it was a budget
 * with nowhere to sit between 411ms of clean work and 1500ms. Adding a vitest
 * `retry` would introduce masking that has never existed here, and vitest's
 * does genuinely retry an assertion into passing.
 *
 * It takes two halves of a reference, not one, and that is the other measured
 * result. A busy box inflates process CPU time because V8's background threads
 * -- concurrent marking during GC, the optimising compiler -- get scheduled
 * alongside the main thread, and which of them does the inflating depends on
 * the *shape* of the contention. Measured as the spread of the factor across
 * the four conditions above:
 *
 *   - a tight numeric loop as the reference: 1.96x. Compute bound, so it barely
 *     sees the background threads the scorer pays for.
 *   - a regexp-and-Set pass over a 64KB posting as the reference: 1.69x. Same
 *     shape as the scorer, and it tracks it under CPU starvation -- but it
 *     allocates ~450k strings per call, so under memory pressure it inflates
 *     3.5x where the scorer inflates 2.2x, and the factor collapses.
 *   - both, geometric mean: 1.24x.
 *
 * Neither half touches the code under test, so a change to the scorer cannot
 * move them, and neither can be optimised away: the compute half's arithmetic
 * is accumulated and the allocation half's count is derived from the strings it
 * builds. Cost: 53ms of CPU idle per repeat, against the scan's 417-1226ms.
 *
 * `process.cpuUsage()` is process-wide rather than per-thread, which is why
 * every repeat is measured next to the reference rather than on its own, and
 * why the median is used rather than the minimum: the first sample after a
 * warm-up is still ~35% high (V8's ramp), and the median discards that and any
 * single background-thread spike without needing a longer warm-up.
 */

/**
 * The tripwire for the 1000-listing measurement, and it is deliberately not
 * measured in wall-clock milliseconds.
 *
 * The obvious version of this -- "give up if the measurement has been going
 * 45s" -- was written, measured, and thrown out: at a load average of 80 on
 * this box a 2x slowdown legitimately needs 10s of wall clock per repeat, so it
 * fired on a measurement that was about to report correctly and printed a 45s
 * that was not the time the scorer had taken. A wall-clock budget on a
 * synchronous measurement is a statement about the box, not about the scorer,
 * which is the mistake the old `elapsed < 1000` guard made in the first place.
 *
 * So the tripwire counts CPU against the same reference the guard asserts
 * against, and only a scorer already 3x past the budget can reach it: clean code
 * measures 16.2-23.1 and the budget is 45. Being CPU-based it cannot be moved
 * by a busy box, because the same work costs the same CPU.
 */
const SCAN_MEASUREMENT_CPU_TRIPWIRE = 150

/**
 * Budget for 1000 scorings of a realistic posting, as a normalised factor.
 *
 * The guard used to assert raw CPU against 1500ms, which is not a trip point
 * on any machine whose speed nobody controls. This is the same 1500ms of
 * headroom expressed against the machine in front of you instead, and it is set
 * from the measured factor range of 16.2 (idle) to 23.1 (busiest):
 *
 *   - correct code runs 45/23.1 = 1.9x below this budget in the busiest
 *     condition measured, and 2.8x below it when idle;
 *   - a 3x slowdown measures 48.6-69.3 and fails in every condition measured,
 *     with at least 8% to spare against the worst trip point (2.78x);
 *   - a 2x slowdown measures 32.4-46.2 and passed in every condition measured,
 *     as it did under the old budget.
 *
 * The honest limit is the band between those two: the trip point is 1.95x on
 * the busiest box measured and 2.78x on the quietest, so somewhere in 2x-2.8x
 * the verdict still depends on the machine. Below ~2x this workload cannot
 * separate correct code from a real regression, which is stated here rather
 * than papered over, and the last test in this describe pins the band.
 *
 * Verified by mutation rather than assumed: `scoreCompatibilityStructured` was
 * made to do its real work N times per call -- identical return value, pure CPU
 * cost -- and this guard re-run at N=1,2,3,4 idle, at 3x CPU oversubscription
 * and under a foreign memory-heavy load. Every level gave the same verdict in
 * every condition.
 */
const SCAN_INTERFERENCE_FACTOR_BUDGET = 45

/**
 * The band the measured clean factor has to stay inside, asserted in the same
 * test, because SCAN_INTERFERENCE_FACTOR_BUDGET is absolute and everything this
 * guard can detect follows from the ratio it measured rather than from the
 * budget: the slowdown that trips the guard is `45 / cleanFactor`, so a clean
 * factor of 15.0 is exactly where a 3x regression stops being caught.
 *
 * Measured on an 8-core darwin-arm64 box, node v26.8.1, vitest 4.1.10, this
 * file alone, clean code at the merged 4_500_000, 23 runs:
 *
 *     condition                            n   clean factor   scan CPU     wall
 *     quiet, nothing else on the box      18   15.76-17.72    428-486     415-456
 *     first run after a burst of runs      1   14.33          570          537
 *     24 CPU spinners (3x oversubscribed)  5   17.54-19.60    650-732    2292-3159
 *     48 CPU spinners (6x oversubscribed)  3   18.24-19.87    704-844    5060-5996
 *     other vitest suites on the box       6   17.87-20.19    905-1109     913-2375
 *
 * 14.33-20.19 overall (the 16.2-23.1 in the table above is the same measurement
 * taken in an earlier session on a box of the same shape; quiet-to-busy the two
 * agree to within 15%). The raw scan CPU moves 2.6x across that table and the
 * normalised factor 1.41x, which is the claim the redesign rests on. Break-even
 * for a 3x regression is 15.0 and the lowest quiet measurement is 15.76, so at
 * the merged constant this guard catches 3x with 5% of margin over its own
 * noise -- and nothing in the suite asserted any of it.
 *
 * Both reference halves are editable constants (`REFERENCE_COMPUTE_PASSES`,
 * `REFERENCE_ALLOC_PASSES`), the budget is a third, and a Node/V8 change moves
 * the ratio without touching the scorer, so the decay is silent by construction.
 * Measured by walking REFERENCE_COMPUTE_PASSES with a mutation in
 * `scoreCompatibilityStructured` -- N calls to `compatibilitySignals` per call,
 * identical return value, pure CPU cost, measured effective multiplier 2.8-3.1x
 * at N=3 -- and changing nothing else. Clean factor quiet, mutated factor under
 * whatever load the box happened to have (contention compresses the ratio, so
 * the mutated column is the pessimistic one):
 *
 *     REFERENCE_COMPUTE_PASSES  drift   clean    3x measures   budget alone   both bounds
 *     4_500_000 (as merged)       --     15.97   48.5 / 52.7   FAIL           FAIL
 *     5_000_000                  +11%    15.43   38.7-47.2     coin flip      FAIL
 *     5_500_000                  +22%    14.83   42.6          PASS - missed  FAIL
 *     6_000_000                  +33%    14.15   41.3          PASS - missed  FAIL
 *     7_000_000                  +56%    13.43   37.4-38.0     PASS - missed  FAIL
 *     8_000_000                  +78%    12.36   35.8          PASS - missed  FAIL
 *     9_000_000                 +100%    11.44   33.6          PASS - missed  FAIL, and clean fails too
 *     11_000_000                +144%    10.64   29.5          PASS - missed  clean fails the floor
 *
 * Clean code passes at every one of those settings, which is why nothing noticed.
 * Read down the last column: with both bounds asserted, every drift measured here
 * is red -- the budget catches 3x up to +11%, the ceiling catches it from +22% to
 * +100% on its own (a 2.85x mutation measures 30 the moment the clean factor falls
 * below ~10.5), and past +100% the floor fails on correct code. There is no
 * setting measured in which the suite is green with a live 3x regression in the
 * scorer, which is the property the guard never had.
 *
 * The bounds have room on both sides, and the room is deliberate. 12 is 16% below
 * the lowest clean factor measured here and 30 is 49% above the highest. A tighter
 * floor would catch more drift and would also fail this guard on correct code: a
 * 14.33 was measured on clean code, the memory pressure that produced it is the
 * mode this file's own docs describe, and an unmeasured machine -- a 2-core CI box
 * is the config's stated target -- is exactly where a bound reverse-engineered from
 * one box's noise bites. Never false-failing is the right way round for a guard
 * whose documented failure mode was false failures.
 *
 * What the floor alone does *not* do, stated rather than hidden: it tolerates drift
 * of up to ~90% on the compute half before complaining about clean code, and the
 * drift that takes the guard past 3x break-even is only ~+25%. So the floor is not
 * what catches that, and could not be -- 15.0 sits inside the measured noise band
 * of 14.33-20.19, so any floor above it false-fails this guard on correct code. The
 * ceiling is what closes the gap, by being a second trip point at a third of the
 * budget rather than a bound on the clean measurement.
 */
const SCAN_CLEAN_FACTOR_FLOOR = 12
const SCAN_CLEAN_FACTOR_CEILING = 30

/**
 * Vitest's own timeout for the same test, which is a ceiling and nothing more.
 * Node cannot preempt a synchronous body, so vitest's timer is only evaluated
 * once the body returns: a body that busy-loops for 7094ms under a 3000ms
 * timeout reports "Test timed out in 3000ms" after 7094ms, and an unbounded
 * synchronous hang reports nothing at all (measured: still running after 600s).
 *
 * So it is sized as the ceiling on legitimate work rather than as a hang
 * detector: the slowest legitimate measurement seen here is a 2x slowdown at a
 * load average of 80 -- 10s of wall clock per repeat, ~60s for the whole test --
 * and this is 2x that. What actually stops a runaway scorer is
 * SCAN_MEASUREMENT_CPU_TRIPWIRE, from inside the loop it is watching, reporting
 * the CPU and wall clock it actually measured.
 */
const SCAN_MEASUREMENT_CEILING_MS = 120_000

/** How many times the scan guard measures. The median of 5 discards one high end and one low end. */
const REPEATS = 5

/**
 * How many times the 12k-word posting guard measures: 3, not 5. Its cost is
 * 34ms against the scan's 421ms, so its wall clock is dominated by measuring
 * the reference beside it -- 5.8s of the 5.8s total at 6x oversubscription, of
 * which the posting itself is 0.2s -- and 3 repeats keep the whole test inside
 * the 5s global timeout on a box that busy. The median of 3 still discards a
 * single background-thread spike, which is the only thing the extra repeats
 * were buying.
 */
const POSTING_REPEATS = 3

/**
 * Ceiling on that same test, because "inside the 5s default" is a statement
 * about this box: 0.4s idle, 5.8s at 6x oversubscription. The assertion inside
 * is on CPU, so the wall clock is only ever a ceiling here.
 */
const POSTING_MEASUREMENT_CEILING_MS = 30_000

/**
 * Budget for scoring one 12k-word posting, as a normalised factor.
 *
 * This was 65, carried over from the old 2000ms bound to keep its headroom, and
 * it guarded nothing: measured clean factor 1.25-2.20 over 24 runs (below), so
 * posting scoring would have had to become ~30x slower to trip it. A budget that
 * cannot fail reads as coverage and is not.
 *
 * 8 is 3.6x above the worst clean factor measured here and 5.2x above the quiet
 * one, which is more headroom than the scan guard's own ceiling keeps over its
 * worst measured clean factor (30 against 20.19), and it is reachable: a posting
 * scorer 3.6x slower on 12k words fails. The regression class this buys is the
 * one the scan guard cannot see - it scores 1000 ~60-word postings, so anything
 * superlinear in posting length barely moves it while it dominates here.
 *
 * What it still does not catch is stated rather than implied: a 2x slowdown on
 * this posting passes, as it did under the old budget, and the old 2000ms bound
 * was 28-43x of headroom against a clean cost of 1.4-2.3.
 *
 * Clean factor measured on this box (8-core darwin-arm64, node v26.8.1, vitest
 * 4.1.10, this file alone), 24 runs of this test:
 *
 *     condition                             n   clean factor   wall clock
 *     quiet                                  12   1.36-1.55      0.41-0.64s
 *     24 CPU spinners (3x oversubscribed)     5   1.25-2.20      2.1s
 *     48 CPU spinners (6x oversubscribed)     3   1.57-1.90      -
 *     other vitest suites on the box          4   1.38-1.55      -
 *
 * The wall clock is dominated by the reference measured beside the posting, not
 * by the posting: 34-80ms of CPU for the posting itself against a 27-67ms
 * reference, three repeats.
 */
const POSTING_INTERFERENCE_FACTOR_BUDGET = 8

describe('performance guard', () => {
  const filler =
    'We partner with commercial teams across the organization and support internal stakeholders through planning cycles, governance reviews, and quarterly planning exercises with measurable outcomes. '
  const skills = 'Requirements include python and kafka and postgres and kubernetes and terraform and spark and airflow and redis and golang. '
  const big = ['Staff Platform Engineer', ''].join('\n') + (filler + skills).repeat(320)

  const engCv = `${CV_ENG}\nLed platform teams, delivered services, quarterly planning cycles.`

  /**
   * Reference half one: compute bound, nothing allocated, ~31ms of CPU idle
   * here.
   */
  const REFERENCE_COMPUTE_PASSES = 4_500_000

  /**
   * Reference half two: allocation bound, and shaped like the scorer --
   * lowercase, tokenise with a global regexp, build a Set, probe it per token --
   * over a 64KB posting-shaped blob. ~22ms of CPU idle here, ~26ms loaded, and
   * ~450k short-lived strings per call, which is what makes it sensitive to the
   * memory pressure the compute half cannot see.
   */
  const referenceDoc = (filler + skills).repeat(200)
  const referenceTerms = new Set([
    'python',
    'kafka',
    'postgres',
    'kubernetes',
    'terraform',
    'spark',
    'airflow',
    'redis',
    'golang',
    'reporting',
    'finance'
  ])
  const REFERENCE_ALLOC_PASSES = 45

  /**
   * Sinks for the two halves' results. They exist so neither half can be
   * optimised away -- a performance reference the optimiser deletes is worse
   * than no reference -- and `referenceAcc` reads them back.
   */
  let computeAcc = 0
  let allocAcc = 0

  function computeReferenceWork(): void {
    let x = 0x12345678
    let y = 1.0000001
    for (let i = 0; i < REFERENCE_COMPUTE_PASSES; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff
      y = y * 1.0000001 + ((x >>> 7) & 1023) / 1024
    }
    computeAcc += x + (y | 0)
  }

  function allocReferenceWork(): void {
    let hits = 0
    for (let pass = 0; pass < REFERENCE_ALLOC_PASSES; pass++) {
      const tokens = referenceDoc.toLowerCase().match(/[a-z]+/g) ?? []
      const distinct = new Set(tokens)
      for (const token of tokens) if (referenceTerms.has(token)) hits++
      hits += distinct.size
    }
    allocAcc += hits
  }

  /**
   * The reference work's own output, read back so neither half can be optimised
   * away -- a performance reference the optimiser deletes is worse than none.
   */
  function referenceAcc(): number {
    return computeAcc + allocAcc
  }

  /** Wall ms and CPU ms for one run of `body`. */
  function timed(body: () => void): { wall: number; cpu: number } {
    const wallStart = performance.now()
    const cpuStart = process.cpuUsage()
    body()
    const used = process.cpuUsage(cpuStart)
    return { wall: performance.now() - wallStart, cpu: (used.user + used.system) / 1000 }
  }

  function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }

  /** Both reference halves of one round, measured back to back. */
  function referenceRound(): { compute: number; alloc: number } {
    const compute = timed(computeReferenceWork).cpu
    const alloc = timed(allocReferenceWork).cpu
    return { compute, alloc }
  }

  /** Both reference halves across the rounds, combined the way the docs above describe. */
  function referenceCost(compute: number[], alloc: number[]): number {
    return Math.sqrt(median(compute) * median(alloc))
  }

  /**
   * The one decision both guards and the estimator test below make: is this
   * much CPU, for this machine, a regression?
   */
  function withinBudget(scanCpu: number, reference: number): boolean {
    return scanCpu / reference < SCAN_INTERFERENCE_FACTOR_BUDGET
  }

  function scoreBigPosting(): number {
    return scoreCompatibilityStructured({
      title: 'Staff Platform Engineer',
      description: big,
      requirements: null,
      location: null,
      baseCv: engCv
    })
  }

  it('scores a 12k-word posting well inside its own budget', () => {
    expect(big.split(/\s+/).length).toBeGreaterThan(10000)
    expect(scoreBigPosting()).toBeGreaterThan(0)

    // One warm-up pass, unmeasured: the first pass through both the scorer and
    // the reference pays V8's ramp, and the median would rather not have to
    // throw that sample away.
    computeReferenceWork()
    allocReferenceWork()
    scoreBigPosting()

    const cpu: number[] = []
    const compute: number[] = []
    const alloc: number[] = []
    const wall: number[] = []
    for (let i = 0; i < POSTING_REPEATS; i++) {
      const ref = referenceRound()
      const run = timed(scoreBigPosting)
      cpu.push(run.cpu)
      compute.push(ref.compute)
      alloc.push(ref.alloc)
      wall.push(run.wall)
    }
    const reference = referenceCost(compute, alloc)
    const factor = median(cpu) / reference
    expect(
      factor,
      `one 12k-word posting used ${median(cpu).toFixed(0)}ms of CPU at the median of ${POSTING_REPEATS}` +
        ` (${cpu.map((c) => c.toFixed(0)).join(', ')}ms) against a reference of ${reference.toFixed(1)}ms` +
        ` (${median(compute).toFixed(1)}ms compute, ${median(alloc).toFixed(1)}ms allocation),` +
        ` a factor of ${factor.toFixed(1)} against a budget of ${POSTING_INTERFERENCE_FACTOR_BUDGET},` +
        ` over ${median(wall).toFixed(0)}ms of wall clock`
    ).toBeLessThan(POSTING_INTERFERENCE_FACTOR_BUDGET)
  }, POSTING_MEASUREMENT_CEILING_MS)

  it('scores realistic postings fast enough for a scan (1000 listings, fails at 3x)', () => {
    const posting = ['Financial Analyst, Reporting', ''].join('\n') + (filler + skills).repeat(2)
    const LISTINGS = 1000
    /** How often the tripwire looks at the clock and the CPU. */
    const TRIPWIRE_EVERY = 100

    // Warm-up pass, unmeasured, and the reference cost it implies: the tripwire
    // needs a denominator before the first repeat has finished.
    computeReferenceWork()
    allocReferenceWork()
    let referenceSoFar = Math.sqrt(timed(computeReferenceWork).cpu * timed(allocReferenceWork).cpu)

    // If either half ever measures 0 then every factor below is Infinity and this
    // guard fails on clean code with "a factor of Infinity" -- a correct message
    // about an impossible measurement. Whether a 22-31ms busy loop can report 0ms
    // of CPU is not established either way; this is here so that if it ever does,
    // the failure says which number was zero instead of what it divided into.
    expect(referenceSoFar, `the reference workload measured ${referenceSoFar.toFixed(2)}ms of CPU`).toBeGreaterThan(0)

    // Taken after the warm-up and asserted against at the end, so this proves the
    // reference ran inside the measured rounds rather than merely somewhere
    // earlier in the file: computeAcc/allocAcc are describe-scoped, so an
    // assertion on the bare accumulator is satisfied by the 12k-word test above.
    const referenceAccAtStart = referenceAcc()

    for (let i = 0; i < LISTINGS; i++) {
      scoreCompatibility('Financial Analyst, Reporting', `${posting} warmup ${i}`, CV_FINANCE)
    }

    const cpu: number[] = []
    const compute: number[] = []
    const alloc: number[] = []
    const wall: number[] = []
    let listingsScored = 0
    const wallStart = performance.now()
    let scanCpuStart = process.cpuUsage()

    for (let repeat = 0; repeat < REPEATS; repeat++) {
      const ref = referenceRound()
      scanCpuStart = process.cpuUsage()
      const run = timed(() => {
        for (let i = 0; i < LISTINGS; i++) {
          // Checked from inside the loop, so it can stop a runaway scorer
          // instead of waiting for it to finish. Counted in CPU against the same
          // reference the guard asserts against, so a busy box cannot move it.
          if (i % TRIPWIRE_EVERY === 0) {
            const used = process.cpuUsage(scanCpuStart)
            const scanCpu = (used.user + used.system) / 1000
            const factorSoFar = scanCpu / referenceSoFar
            if (factorSoFar > SCAN_MEASUREMENT_CPU_TRIPWIRE) {
              const finished = cpu.map((c) => `${c.toFixed(0)}ms`).join(', ')
              const measured = finished ? ` (${finished} in the repeats that finished)` : ''
              throw new Error(
                `the 1000-listing measurement reached an interference factor of ${factorSoFar.toFixed(0)}` +
                  ` against a reference of ${referenceSoFar.toFixed(1)}ms` +
                  ` (tripwire ${SCAN_MEASUREMENT_CPU_TRIPWIRE}, budget ${SCAN_INTERFERENCE_FACTOR_BUDGET})` +
                  ` after ${repeat} completed repeats and ${listingsScored + i} listings, using` +
                  ` ${scanCpu.toFixed(0)}ms of CPU over ${(performance.now() - wallStart).toFixed(0)}ms of wall clock` +
                  `${measured}. Stopped mid-measurement rather than spending five repeats confirming it.`
              )
            }
          }
          scoreCompatibility('Financial Analyst, Reporting', `${posting} posting ${i}`, CV_FINANCE)
        }
      })
      cpu.push(run.cpu)
      compute.push(ref.compute)
      alloc.push(ref.alloc)
      wall.push(run.wall)
      listingsScored += LISTINGS
      referenceSoFar = referenceCost(compute, alloc)

      // The verdict only needs two repeats to be decided, and a regression large
      // enough to trip it costs 1-7s of wall clock per repeat under load:
      // spending three more repeats to reach the same answer is what let a 6x
      // regression overrun the whole budget before it could report anything.
      if (cpu.length >= 2 && !withinBudget(median(cpu), referenceSoFar)) break
    }

    const reference = referenceCost(compute, alloc)
    const factor = median(cpu) / reference
    expect(
      factor,
      `1000 scorings used ${median(cpu).toFixed(0)}ms of CPU at the median of ${cpu.length} of ${REPEATS} repeats` +
        ` (${cpu.map((c) => c.toFixed(0)).join(', ')}ms) against a reference of ${reference.toFixed(1)}ms` +
        ` (${median(compute).toFixed(1)}ms compute, ${median(alloc).toFixed(1)}ms allocation),` +
        ` a factor of ${factor.toFixed(1)} against a budget of ${SCAN_INTERFERENCE_FACTOR_BUDGET},` +
        ` over ${median(wall).toFixed(0)}ms of wall clock (${wall.map((w) => w.toFixed(0)).join(', ')}ms)` +
        ` over ${listingsScored} listings`
    ).toBeLessThan(SCAN_INTERFERENCE_FACTOR_BUDGET)

    // And the ratio itself, two-sided, because the assertion above is only as
    // good as the denominator: pass a 3x regression by editing either reference
    // constant and the budget still says "under budget", forever, with clean code
    // green at every step. The message states the trip point rather than the
    // factor, because the trip point is the consequence.
    const tripPoint = SCAN_INTERFERENCE_FACTOR_BUDGET / factor
    const drift = ` A trip point of ${tripPoint.toFixed(2)}x means a ${tripPoint.toFixed(1)}x regression ` +
      `${tripPoint >= 3 ? 'still fails' : 'passes'} this guard. The usual cause is a change to ` +
      `REFERENCE_COMPUTE_PASSES (${REFERENCE_COMPUTE_PASSES}) or REFERENCE_ALLOC_PASSES (${REFERENCE_ALLOC_PASSES}); ` +
      `clean code measured 14.33-20.19 over 23 runs from quiet to 6x oversubscribed.`
    expect(
      factor,
      `1000 clean scorings used ${median(cpu).toFixed(0)}ms of CPU at the median of ${cpu.length} of ${REPEATS} repeats` +
        ` against a reference of ${reference.toFixed(1)}ms, an interference factor of ${factor.toFixed(1)},` +
        ` below the ${SCAN_CLEAN_FACTOR_FLOOR} this guard needs to keep detecting a 3x regression.${drift}`
    ).toBeGreaterThan(SCAN_CLEAN_FACTOR_FLOOR)
    expect(
      factor,
      `1000 clean scorings used ${median(cpu).toFixed(0)}ms of CPU at the median of ${cpu.length} of ${REPEATS} repeats` +
        ` against a reference of ${reference.toFixed(1)}ms, an interference factor of ${factor.toFixed(1)},` +
        ` above the ${SCAN_CLEAN_FACTOR_CEILING} this guard is calibrated for.${drift}`
    ).toBeLessThan(SCAN_CLEAN_FACTOR_CEILING)

    // The reference work is only a reference if it ran. Asserted as growth across
    // this test's own rounds, which the previous bare `> 0` could not distinguish
    // from the 12k-word test's contribution.
    expect(
      referenceAcc(),
      `the reference workload's output did not grow across this test's ${cpu.length} measured rounds`
    ).toBeGreaterThan(referenceAccAtStart)
  }, SCAN_MEASUREMENT_CEILING_MS)

  it('brackets the trip point between the two recorded conditions', () => {
    // What this pins is the *budget* against two recorded measurements, not
    // load-independence as a live property. It is arithmetic over the quietest
    // and busiest conditions measured with this guard, 1.31x of factor apart,
    // replayed at several slowdown factors.
    //
    // The old title here was "gives a slowdown the same verdict idle and under
    // load", which overstated it: nothing in this body measures anything, and it
    // stayed green through a 10x-wrong CPU figure in `timed()`. The live claim
    // is asserted by the clean-factor band in the scan test above, on a factor
    // this run actually measured; this test only says the recorded numbers sit
    // where the budget's comment says they sit.
    const QUIET_BOX = { scanCpu: 430, reference: 26.4 }
    const BUSY_BOX = { scanCpu: 1020, reference: 47.9 }

    // Outside the band between the two trip points the verdicts must agree.
    for (const slowdown of [1, 1.5, 2, 3, 4, 7]) {
      expect(withinBudget(QUIET_BOX.scanCpu * slowdown, QUIET_BOX.reference), `quiet box at ${slowdown}x`).toBe(
        withinBudget(BUSY_BOX.scanCpu * slowdown, BUSY_BOX.reference)
      )
    }

    // And the same numbers say what the guard is worth: correct code is inside
    // the budget in both conditions, and 3x is outside it in both.
    expect(withinBudget(QUIET_BOX.scanCpu, QUIET_BOX.reference)).toBe(true)
    expect(withinBudget(BUSY_BOX.scanCpu, BUSY_BOX.reference)).toBe(true)
    expect(withinBudget(QUIET_BOX.scanCpu * 3, QUIET_BOX.reference)).toBe(false)
    expect(withinBudget(BUSY_BOX.scanCpu * 3, BUSY_BOX.reference)).toBe(false)

    // Inside the band -- and only inside it -- the two boxes still disagree, and
    // that is the guard's stated limit rather than a gap in the test: at 2.5x
    // the quiet box is still inside the budget and the busy box is not.
    expect(withinBudget(QUIET_BOX.scanCpu * 2.5, QUIET_BOX.reference)).toBe(true)
    expect(withinBudget(BUSY_BOX.scanCpu * 2.5, BUSY_BOX.reference)).toBe(false)

    // A machine that is merely slow, rather than busy, must not matter either:
    // both sides scale with the core, so the factor is unchanged.
    for (const slowerCore of [0.25, 0.5, 2, 4]) {
      expect(
        withinBudget(QUIET_BOX.scanCpu * slowerCore, QUIET_BOX.reference * slowerCore),
        `${slowerCore}x slower core`
      ).toBe(true)
    }
  })
})
