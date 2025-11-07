# 🧠 AI UI State Capture System  
### (Softlight Engineering — AI Engineer Take-Home Assignment)

---

## 📘 Overview

This project implements an intelligent **AI UI State Capture System (Agent B)** that autonomously navigates real web applications — such as **Linear**, **Notion**, and **Asana** — to perform natural-language tasks like:

> “How do I create a project in Linear?”  
> “How do I filter a database in Notion to show only ‘Project Alpha Launch’?”

Agent B automatically plans, executes, and captures **each intermediate UI state** (including modals and popovers) — even for elements with **no unique URLs** — creating a clear step-by-step understanding of the workflow.

---

## 🚀 Key Features

- **Planner–Executor Architecture**
  - **Planner (LLM)** converts plain-language queries into structured JSON plans with checkpoints and selectors.
  - **Executor (Playwright)** executes each plan step dynamically, verifying selectors, clickability, and fillability.

- **Automatic UI State Capture**
  - Captures full-page screenshots at every checkpoint.
  - Handles transient UI states like dialogs, dropdowns, and filters.

- **LLM-Based Recovery**
  - Automatically retries failed actions using alternative selectors suggested by the model.

- **Fully Generalizable**
  - Designed to handle unseen tasks across multiple apps without hardcoded flows.

---

## 🧩 Architecture

| Component | Description |
|------------|-------------|
| **Planner** | Uses a large language model (via the Vercel AI SDK) to interpret tasks and produce a structured JSON plan containing checkpoints and Playwright selectors. |
| **Executor** | Runs the plan in a real browser (Playwright), handling `goto`, `click`, `fill`, `waitForSelector`, `screenshot`, etc., while capturing screenshots at each step. |
| **Recovery Agent** | When a step fails, dynamically re-prompts the planner to propose alternative selectors or fallback actions. |

---

## 📁 Repository Structure
ui-state-capture/
│
├── src/
│   ├── core/
│   │   ├── planner.ts       # LLM-based planner producing structured checkpoint plans
│   │   └── executor.ts      # Robust Playwright executor handling actions and recovery
│   ├── scripts/
│   │   └── test_capture.ts  # Entry point: runs full flow from text prompt to UI capture
│   └── utils/               # Helper utilities
│
├── outputs/
│   ├── capture/             # Planner output (plan JSON, initial DOM summary, landing page)
│   └── screenshots/         # All captured UI state images
│
├── package.json
├── tsconfig.json
└── README.md
---

## ⚙️ Setup Instructions

### 1️⃣ Clone the Repository

```bash
git clone https://github.com/<your-username>/ui-state-capture.git
cd ui-state-capture
npm install
npm install typescript --save-dev
npx playwright install
npm install ai openai vercel

Run a Capture Task
You can test any supported app/task using a plain-English instruction:
node --loader ts-node/esm src/scripts/test_capture.ts "How do I create a project in Linear?"

Each execution:
Generates a planner output (plan JSON).
Runs it through the executor.
Captures full-page screenshots of each UI state.
Logs recovery attempts if an action fails.

| Task                            | App    | Description                                                                       |
| ------------------------------- | ------ | --------------------------------------------------------------------------------- |
| **Create a project in Linear**  | Linear | Opens the project dashboard, clicks *Create project*, fills details, and submits. |
| **Filter issues in Linear**     | Linear | Applies a *Status = In Progress* filter and captures the filtered state.          |
| **Create a task in Asana**      | Asana  | Opens quick-add, creates a task titled *Homework*, and verifies success.          |
| **Create a database in Notion** | Notion | Adds a new database and populates entries.                                        |
| **Filter a Notion database**    | Notion | Filters entries to display only *Project Alpha Launch*.                           |

🧾 Output
Each task execution automatically generates:
A plan JSON (LLM-generated structured steps)
A DOM summary for grounding
Full-page screenshots for each checkpoint
Metadata describing each step
Screenshots and metadata are stored locally in the outputs/ directory
(ignored in the public GitHub repo to avoid large binary uploads).

| Category           | Technology                                                        |
| ------------------ | ----------------------------------------------------------------- |
| **Language**       | TypeScript                                                        |
| **Automation**     | [Playwright](https://playwright.dev/)                             |
| **AI Integration** | [Vercel AI SDK](https://sdk.vercel.ai/), OpenAI-compatible models |
| **Execution**      | Node.js (ESM loader)                                              |
| **Data Capture**   | Full-page screenshots + structured metadata                       |

