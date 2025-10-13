# Sitegeist: Technical Documentation & Business Model

## Executive Summary

Sitegeist is a browser extension that brings advanced AI assistance directly into the web browsing experience. Unlike traditional AI chatbots that operate in isolation, Sitegeist can see, interact with, and automate any website the user visits. It combines natural language understanding with direct browser automation, making the web programmable through conversation.

**Core Value Proposition**: Turn any website into an API through natural language. No more copy-pasting between tabs, manual data extraction, or repetitive web tasks.

---

## What Sitegeist Can Do

### Core Capabilities

#### 1. **Web Automation**
- **Click, type, scroll, navigate**: Sitegeist can interact with any webpage as if it were a human
- **Form filling**: Automatically fill out complex forms by understanding field labels and context
- **Multi-step workflows**: Chain actions across multiple pages (e.g., "Find the cheapest hotel, add it to cart, and apply coupon code XYZ")
- **Smart waiting**: Automatically waits for page loads, animations, and dynamic content

#### 2. **Data Extraction**
- **Structured data extraction**: Pull tables, lists, search results into clean formats
- **Multi-page scraping**: Collect data across pagination, infinite scroll, or multiple tabs
- **PDF/Excel/Word reading**: Extract and analyze data from documents
- **Screenshot analysis**: Take and analyze screenshots of any page element

#### 3. **Content Analysis**
- **Page summarization**: Distill long articles, documentation, or product pages
- **Comparison**: Compare products, prices, reviews across multiple sites
- **Research**: Gather information from multiple sources and synthesize findings
- **Translation & simplification**: Make complex content accessible

#### 4. **Content Creation**
- **Code artifacts**: Write HTML/CSS/JS apps that run in isolated sandboxes
- **Document generation**: Create PDFs, spreadsheets, Word documents from web data
- **Script generation**: Generate automation scripts (.sh, .js, etc.)
- **Visual content**: Create charts, dashboards, and interactive visualizations

#### 5. **Advanced Browser Access**
- **Cookie access**: Read all cookies including HttpOnly (via debugger tool)
- **MAIN world JavaScript**: Access page internals that normal scripts cannot (React state, Angular controllers, etc.)
- **Framework inspection**: Interact with page JavaScript frameworks directly

#### 6. **Domain-Specific Skills**
Extensible skill system for specialized automation:
- **Google Search**: Extract structured search results, related searches, featured snippets
- **YouTube**: Control playback, extract transcripts, fetch comments, manage playlists
- **WhatsApp Web**: List chats, read messages, send messages (with user confirmation)
- **Custom skills**: Users can create and share skills for any website

---

## What Sitegeist Cannot Do

### Technical Limitations
1. **CAPTCHA bypass**: Cannot solve CAPTCHAs or anti-bot challenges (by design)
2. **Login credential storage**: Does not store or manage passwords (security by design)
3. **Rate limit bypass**: Respects website rate limits and robots.txt
4. **Browser fingerprinting evasion**: Does not attempt to hide extension presence
5. **File system access**: Cannot read/write files outside the browser sandbox (except downloads)
6. **Background operation**: Requires the browser to be open and extension active
7. **Mobile support**: Currently desktop-only (Chrome/Firefox extensions)

### Ethical Boundaries
1. **No credential harvesting**: Will not extract passwords, API keys, or auth tokens in bulk
2. **No malicious automation**: Refuses to create scripts for spam, harassment, or abuse
3. **No ToS violation assistance**: Will not help users violate website Terms of Service
4. **No financial transactions**: Will not complete purchases without explicit user confirmation
5. **Privacy respect**: Does not send browsing data to external servers without user consent

### Business Limitations
1. **No offline mode**: Requires internet connection for AI inference
2. **No mobile app**: Browser extension only (no standalone mobile app)
3. **No enterprise SSO**: Individual user accounts only (v1)
4. **No on-premise deployment**: Cloud-hosted AI models only

---

## Use Cases by Sector

### 1. **E-Commerce & Shopping**
- **Price comparison**: "Compare prices for MacBook Pro M3 across Amazon, Best Buy, and B&H"
- **Deal hunting**: "Check Slickdeals for laptop deals under $1000 and create a comparison table"
- **Review analysis**: "Summarize the negative reviews for this product and identify common issues"
- **Coupon application**: "Find and apply the best coupon code for this order"
- **Inventory tracking**: "Check if this item is in stock at stores near 90210"

**Pain solved**: Hours spent tabbing between sites, copy-pasting, and manually comparing specs/prices.

### 2. **Research & Academia**
- **Literature review**: "Search Google Scholar for papers about transformer architectures from 2023-2024"
- **Citation extraction**: "Extract all citations from this paper and create a BibTeX file"
- **Data collection**: "Download all datasets from this research portal with documentation"
- **Source verification**: "Check if this claim is supported by sources, find original references"
- **Multi-source synthesis**: "Compare how three different news sources cover this event"

**Pain solved**: Manual data collection, citation management, cross-referencing sources.

### 3. **Recruitment & HR**
- **Candidate sourcing**: "Find 20 senior React developers in NYC from LinkedIn with 5+ years experience"
- **Profile analysis**: "Compare these three candidates' experience against our job requirements"
- **Salary benchmarking**: "What's the average salary for this role in San Francisco?"
- **Job posting**: "Create a job listing based on this template and post to Indeed"
- **Application tracking**: "Check for new applications on our careers page daily"

**Pain solved**: Manual candidate screening, data entry across multiple platforms.

### 4. **Marketing & SEO**
- **Competitor analysis**: "Analyze competitor's blog content strategy for the past 3 months"
- **Keyword research**: "Extract search volume and competition for these 50 keywords"
- **Backlink analysis**: "Find sites linking to competitor but not to us"
- **Content audit**: "List all our blog posts with word count, last updated date, and traffic"
- **Ad monitoring**: "Track competitor ads on Google for these keywords"

**Pain solved**: Manual data extraction from SEO tools, competitor monitoring.

### 5. **Real Estate**
- **Listing aggregation**: "Find 3BR apartments in Brooklyn under $3500 from Zillow, StreetEasy, and Apartments.com"
- **Market analysis**: "What's the average price per sqft in this neighborhood?"
- **Property comparison**: "Create a comparison spreadsheet of these 5 properties"
- **Neighborhood research**: "Summarize school ratings, crime stats, and amenities near this address"
- **Open house scheduling**: "Check for open houses this weekend within 5 miles"

**Pain solved**: Manual listing comparison, data scattered across multiple sites.

### 6. **Legal & Compliance**
- **Regulatory research**: "Find all FDA updates about medical device regulations from 2024"
- **Case law search**: "Find precedents for GDPR enforcement cases in Germany"
- **Document analysis**: "Extract key terms and obligations from this 50-page contract"
- **Compliance monitoring**: "Check if our privacy policy matches CCPA requirements"
- **Docket tracking**: "Monitor this court docket for new filings"

**Pain solved**: Manual legal research, document review, regulatory monitoring.

### 7. **Finance & Investment**
- **Stock screening**: "Find stocks with P/E < 15, dividend yield > 3%, market cap > $1B"
- **Financial statement analysis**: "Extract revenue growth, margins, and debt ratios from this 10-K"
- **News monitoring**: "Track news mentions of these 10 companies and sentiment"
- **Crypto tracking**: "Monitor these tokens across Binance, Coinbase, and Uniswap"
- **Portfolio rebalancing**: "Calculate optimal asset allocation based on current holdings"

**Pain solved**: Manual financial data aggregation, multi-platform monitoring.

### 8. **Customer Support**
- **Issue research**: "Search our support docs for solutions to this error message"
- **Status checking**: "Check order status for customer #12345 across all systems"
- **Competitor comparison**: "How does competitor X handle this feature vs. us?"
- **Help desk automation**: "Create a ticket for this user with extracted details"
- **Knowledge base maintenance**: "Find outdated articles mentioning old product names"

**Pain solved**: Manual knowledge base searches, system integration gaps.

### 9. **Content Creation & Journalism**
- **Fact checking**: "Verify these 5 claims with primary sources"
- **Interview prep**: "Research this person's background, recent work, and social media"
- **Image sourcing**: "Find Creative Commons images related to climate change"
- **Statistics gathering**: "Get latest unemployment, GDP, and inflation stats"
- **Source compilation**: "Create a source list with quotes from these 10 articles"

**Pain solved**: Manual research, fact-checking, source management.

### 10. **Travel & Hospitality**
- **Trip planning**: "Find round-trip flights NYC to Tokyo under $800 and hotels near Shibuya"
- **Itinerary building**: "Create a 5-day Tokyo itinerary with popular attractions and restaurants"
- **Review aggregation**: "Summarize reviews for these 3 hotels focusing on cleanliness"
- **Visa requirements**: "What documents do I need for a Japan tourist visa?"
- **Restaurant reservations**: "Check OpenTable for available 7pm slots this weekend"

**Pain solved**: Fragmented booking platforms, manual itinerary creation.

### 11. **Education & Online Learning**
- **Course comparison**: "Compare Udemy, Coursera, and edX courses on machine learning"
- **Learning path**: "Create a structured learning plan from free resources for web development"
- **Assignment research**: "Find 5 primary sources about the French Revolution"
- **Study material**: "Extract practice problems from these math tutorial sites"
- **Grade tracking**: "Check grades across Canvas, Blackboard, and Google Classroom"

**Pain solved**: Course discovery, resource aggregation across platforms.

### 12. **Healthcare (Consumer)**
- **Symptom research**: "What are common causes of these symptoms?" (educational only)
- **Doctor search**: "Find cardiologists near me accepting new patients with ratings > 4.0"
- **Insurance comparison**: "Compare these 3 health insurance plans for a family of 4"
- **Appointment scheduling**: "Check available slots at these 5 clinics next week"
- **Medical record organization**: "Extract lab results from these PDF reports into a table"

**Pain solved**: Healthcare provider search, insurance complexity, medical record management.

---

## User Experience (UX)

### Interface Design

#### **Side Panel Architecture**
- **Always-accessible**: Cmd+Shift+P to toggle, doesn't disrupt browsing
- **Contextual awareness**: Automatically sees current page without manual prompting
- **Split-screen efficiency**: Work alongside the AI without switching tabs
- **Responsive**: Adjusts to panel width, can be widened for better viewing

#### **Chat Interface**
- **Natural conversation**: No commands to memorize, just describe what you want
- **Rich output**:
  - Formatted text with markdown
  - Code blocks with syntax highlighting
  - Interactive artifacts (HTML previews, data tables)
  - Collapsible tool execution logs
  - Inline images and screenshots
- **Message attachments**: Upload PDFs, images, Word, Excel files directly
- **Quick prompts**: Pre-built prompts for common tasks (visible on empty state)

#### **Artifacts Panel**
- **Live previews**: HTML run in isolated sandboxes with console output
- **File management**: Create, edit, download multiple artifacts
- **Export formats**: PDF, Excel, Word, text, code files
- **Code editing**: Basic syntax highlighting and validation

#### **Skills System**
- **Automatic detection**: Suggests relevant skills when visiting supported sites
- **Easy creation**: Natural language skill builder (in progress)
- **Skill sharing**: Import/export skills as JSON (future: skill marketplace)

### Onboarding Experience

#### **First-time Setup** (< 2 minutes)
1. Install extension from Chrome/Firefox store
2. Click extension icon → opens side panel
3. Enter API key (supports Anthropic, OpenAI, Google, Groq, xAI, OpenRouter)
4. Optional: Enable permissions (userScripts for automation)
5. Interactive tutorial walks through 3 example tasks:
   - "Search Google for chocolate chip cookie recipes"
   - "Analyze this YouTube video's transcript"
   - "Create a simple HTML counter app"

#### **Progressive Disclosure**
- Core features visible immediately (chat, skills, settings)
- Advanced features revealed contextually (debugger tool, custom skills)
- Helpful error messages with troubleshooting links
- Non-technical language in prompts and responses

### Error Handling
- **Graceful failures**: Clear error messages, never crashes silently
- **Retry mechanisms**: Automatically retries transient failures
- **User control**: Abort button always visible during execution
- **Debug mode**: Optional detailed logging for troubleshooting

---

## Planned Features & Roadmap

### Q1 2025: User Management & Monetization

#### **User Accounts**
- **Registration**: Email + password or OAuth (Google, GitHub)
- **Profile management**: Name, avatar, preferences
- **API key storage**: Encrypted server-side storage (optional, user choice)
- **Usage tracking**: Message count, token consumption, quota remaining

#### **Subscription Plans**

**Free Tier** (Limited)
- 50 messages/month
- Community support
- All core features
- Manual API key management

**Pro Tier** ($20/month)
- 500 messages/month included
- Automatic API key management (we handle costs)
- Priority support (24h response)
- Early access to new features
- All updates included
- Top-up available: $5 per 100 additional messages

**Team Tier** ($50/month, up to 5 users)
- 2000 messages/month pooled
- Shared skill library
- Team analytics dashboard
- Admin controls
- Dedicated support (12h response)

**Enterprise Tier** (Custom pricing)
- Unlimited users
- SSO integration
- Custom skill development
- SLA guarantees
- On-premise option (future)
- Dedicated account manager

#### **Payment Processing**
- Stripe integration for subscriptions
- Automatic billing on message quota renewal
- Usage alerts at 80% and 100% quota
- Transparent billing dashboard with per-message cost breakdown

#### **Message Quota Logic**
- 1 message = 1 user prompt + AI response + all tool executions
- Long conversations count each turn separately
- Retries/edits don't count as new messages
- Quota resets monthly (or pro-rated for upgrades)

### Q2 2025: Collaboration & Sharing

#### **Skill Marketplace**
- Public skill library with ratings/reviews
- Revenue sharing: 70% to creator, 30% platform fee
- Skill pricing: Free or $1-20 one-time purchase
- Premium skills for specialized domains (legal, medical, finance)
- Verified skill badges for tested/reviewed skills

#### **Team Features**
- Shared conversation history (opt-in)
- Collaborative skill editing
- Team templates and workflows
- Usage analytics per team member

#### **Prompt Templates**
- Save and share custom prompts
- Template marketplace (similar to skill marketplace)
- Variables and conditional logic in templates

### Q3 2025: Mobile & Cross-Platform

#### **Mobile Support**
- iOS/Android browser extensions (Safari, Samsung Internet)
- Native mobile UI optimized for smaller screens
- Cloud sync for conversation history and skills
- Mobile-specific features (photo capture, location)

#### **Desktop Apps**
- Electron wrapper for Mac/Windows/Linux
- Deeper OS integration (clipboard, notifications)
- Offline mode for basic features
- Local LLM support (Llama, Mistral)

### Q4 2025: Enterprise & Advanced Features

#### **Enterprise Features**
- SSO (SAML, OAuth) integration
- Role-based access control (RBAC)
- Audit logs and compliance reporting
- Data residency options (US, EU, Asia)
- Custom model deployment (private Claude instances)

#### **Advanced Automation**
- Visual workflow builder (low-code automation)
- Scheduled tasks (daily, weekly, on-event)
- Webhooks and API access (trigger Sitegeist from external systems)
- Browser automation recording (record actions, convert to skills)

#### **AI Improvements**
- Multi-modal models (vision, voice input)
- Longer context windows (500k+ tokens)
- Custom fine-tuned models for specific domains
- Chain-of-thought reasoning visualization

---

## Technical Implementation

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser Extension                     │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Side Panel │  │   Content    │  │     Background   │  │
│  │    (UI)     │  │   Scripts    │  │    Service       │  │
│  │             │  │  (Injection)  │  │     Worker       │  │
│  │  - Chat     │  │              │  │                  │  │
│  │  - Artifacts│  │  - USER_SCRIPT│  │  - Tab mgmt     │  │
│  │  - Settings │  │  - Skills lib │  │  - Message bus  │  │
│  └──────┬──────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                │                    │             │
│         └────────────────┴────────────────────┘             │
│                          │                                  │
└──────────────────────────┼──────────────────────────────────┘
                           │
                    ┌──────▼────────┐
                    │   API Layer   │
                    │               │
                    │ - Anthropic   │
                    │ - OpenAI      │
                    │ - Google      │
                    │ - OpenRouter  │
                    └───────────────┘
```

### Technology Stack

#### **Frontend**
- **UI Framework**: Lit (Web Components) - lightweight, fast, no virtual DOM overhead
- **Styling**: Tailwind CSS - utility-first, minimal CSS bundle
- **Build**: esbuild - fast bundling, tree-shaking
- **Language**: TypeScript - type safety, better DX

#### **AI Integration**
- **Primary SDK**: @mariozechner/pi-ai - unified API for multiple LLM providers
- **Providers**:
  - Anthropic Claude (Sonnet 3.5, Opus)
  - OpenAI (GPT-4, GPT-4 Turbo)
  - Google (Gemini 1.5 Pro/Flash)
  - Groq (ultra-fast inference)
  - xAI (Grok)
  - OpenRouter (200+ models)
- **Tool calling**: Native function calling APIs (not prompt-based)
- **Streaming**: SSE for real-time responses

#### **Browser APIs**
- **Manifest V3**: Future-proof, better performance, enhanced security
- **userScripts API**: USER_SCRIPT world isolation for safe script injection
- **Chrome DevTools Protocol (CDP)**: MAIN world access for debugger tool
- **Tabs/Windows API**: Multi-tab management
- **Storage API**: Local settings and conversation persistence
- **Cookies API**: Cookie reading for authenticated automation

#### **Security & Sandboxing**
- **CSP-compliant**: All code execution in isolated sandboxes
- **USER_SCRIPT world**: Isolated from page scripts, cannot be tampered with
- **Artifact sandboxing**: HTML/JS artifacts run in CSP-restricted iframes
- **No eval()**: No dynamic code execution in main extension context
- **Permission model**: Explicit user consent for sensitive operations

### Data Flow

#### **User Message → AI Response**
1. User types message in chat
2. Frontend validates input, checks quota
3. Message + page context + conversation history → API
4. LLM generates response with tool calls
5. Tools execute in browser (navigate, click, extract)
6. Tool results → LLM for synthesis
7. Final response streamed to UI
8. Message saved to local storage

#### **Tool Execution Flow**
1. LLM decides to use tool (e.g., `browser_javascript`)
2. Frontend receives tool call from stream
3. Tool validation (params, permissions)
4. Tool execution:
   - `browser_javascript`: Injects script into USER_SCRIPT world
   - `navigate`: Uses tabs API to navigate
   - `skill`: Loads skill library into page, calls function
5. Tool result (success/error) returned to LLM
6. LLM continues or finishes response

#### **Skill System Architecture**
```javascript
// Skill definition (stored in IndexedDB)
{
  name: "google",
  domainPatterns: ["google.com", "google.*/search*"],
  library: "window.google = { getSearchResults() { ... } }",
  shortDescription: "Extract Google search results",
  description: "Full documentation...",
  examples: "google.getSearchResults()..."
}

// Skill injection (when domain matches)
1. Page loads → check domain against patterns
2. Match found → suggest skill to LLM in system prompt
3. LLM uses skill → inject library code into page
4. LLM calls skill function → browser_javascript executes
5. Result returned → LLM processes and responds
```

### Performance Optimizations

- **Lazy loading**: Only load tools/skills when needed
- **Code splitting**: Separate bundles for panel, background, tools
- **Streaming responses**: Show partial results immediately
- **Local caching**: Cache LLM responses for repeated queries
- **Debounced updates**: Batch DOM observations to reduce overhead
- **Memory management**: Clear old conversation history automatically

### Scalability Considerations

#### **Current (v1.0)**
- All processing client-side (except LLM inference)
- No server backend required
- User manages own API keys
- Local storage only (no cloud sync)

#### **Future (v2.0 with accounts)**
- Backend: Node.js + PostgreSQL (user management, billing)
- API Gateway: Rate limiting, quota enforcement, usage tracking
- Cache layer: Redis for frequently used responses
- CDN: Cloudflare for static assets and skill marketplace
- Storage: S3 for user artifacts, conversation backups

#### **Scaling LLM Costs**
- **Caching**: Prompt caching for repeated system prompts (~90% cost reduction)
- **Model routing**: Use cheaper models for simple tasks (Haiku for navigation, Sonnet for reasoning)
- **Quota enforcement**: Hard limits prevent runaway costs
- **Compression**: Minimize conversation history sent to LLM
- **Batch processing**: Group similar requests when possible

---

## Business Model Analysis

### Revenue Streams

#### **1. Subscription Revenue** (Primary)
**Assumptions:**
- Average Revenue Per User (ARPU): $20/month
- Target: 10,000 paid users by end of Year 1
- Gross Revenue: $200k/month = $2.4M/year
- Churn rate: 5%/month (typical for dev tools)

**Cost Structure:**
- LLM API costs: ~$8/user/month (500 messages @ $0.016/message avg)
- Stripe fees: $0.60/user/month (3%)
- Server/infrastructure: $2/user/month at scale
- Support: $1/user/month (community + ticket system)
- **Net margin: $8.40/user/month (42%)**

#### **2. Top-Up Revenue** (Secondary)
- 30% of users exceed monthly quota
- Average top-up: $10/month/user
- Additional revenue: $30k/month from 10k user base

#### **3. Skill Marketplace** (Future)
- Platform fee: 30% of skill sales
- Estimated average: $5/skill, 20% attach rate
- At 10k users: $10k one-time marketplace revenue/month

#### **4. Enterprise Licenses** (Future, Year 2+)
- $500-5000/month per enterprise (50-500 seats)
- Higher margin (80%+) due to annual contracts
- 10 enterprise customers = $60k-600k/month

### Total Addressable Market (TAM)

#### **Serviceable Addressable Market (SAM)**
- Chrome Web Store: 200M+ users
- Developer tools category: ~10M active users
- Power users who pay for productivity: ~1M users
- **SAM: $20M/month ($240M/year) at 100% penetration**

#### **Serviceable Obtainable Market (SOM)**
- Realistic market share: 1-5% in 3 years
- Target: 10k-50k paid users
- **SOM: $200k-1M/month ($2.4M-12M/year)**

### Competitive Analysis

#### **Direct Competitors**
1. **Browser Copilots**
   - Microsoft Edge Copilot (free, limited features)
   - Opera AI (free, basic assistance)
   - **Advantage**: Deeper automation, skill system, artifacts

2. **RPA Tools**
   - UiPath, Automation Anywhere (enterprise, complex)
   - Zapier (workflow automation, not AI-native)
   - **Advantage**: Natural language, no coding required, browser-native

3. **AI Coding Assistants**
   - GitHub Copilot ($10/month, code-only)
   - Cursor ($20/month, IDE-focused)
   - **Advantage**: Web-specific, automation beyond coding

#### **Indirect Competitors**
- ChatGPT Plus ($20/month) - no browser automation
- Perplexity Pro ($20/month) - research only, no actions
- Claude Pro ($20/month) - no browser integration

#### **Competitive Moats**
1. **Browser-native architecture**: Cannot be replicated by web apps
2. **Skill ecosystem**: Network effects from skill marketplace
3. **Multi-provider AI**: Not locked to single LLM vendor
4. **Privacy-first**: Local-first processing, no data mining
5. **Domain expertise**: Deep understanding of browser automation challenges

### Go-to-Market Strategy

#### **Phase 1: Early Adopters (Months 1-6)**
**Target**: Developers, power users, AI enthusiasts
- **Free tier**: Build user base and gather feedback
- **Community building**: Discord, Reddit (r/webdev, r/ChatGPT)
- **Content marketing**:
  - Blog: "10 ways Sitegeist saves developers hours"
  - YouTube: Demo videos showing impressive automation
  - Twitter: Daily use case threads
- **Product Hunt launch**: Aim for #1 Product of the Day
- **Goal**: 1,000 active free users, 100 paid conversions

#### **Phase 2: Professional Users (Months 6-12)**
**Target**: Marketers, researchers, analysts, freelancers
- **Paid tier launch**: Introduce $20/month Pro plan
- **Use case marketing**:
  - Industry-specific landing pages (SEO, e-commerce, research)
  - Case studies with early power users
  - Webinars: "Automate your [job function] with AI"
- **Partnerships**:
  - Affiliate deals with productivity YouTubers/bloggers
  - Integration with productivity tools (Notion, Airtable)
- **Goal**: 5,000 free users, 500 paid users

#### **Phase 3: Team & Enterprise (Year 2)**
**Target**: SMBs, agencies, enterprises
- **Team plans**: Launch team collaboration features
- **Sales team**: Hire 2-3 sales reps for outbound
- **Enterprise features**: SSO, compliance, custom contracts
- **Goal**: 10,000 free users, 2,000 paid users, 10 enterprise deals

### Unit Economics

#### **Customer Acquisition Cost (CAC)**
- Organic (content, SEO): $5/user
- Paid ads (Google, Facebook): $50/user
- Affiliate (30% commission): $6/user
- **Blended CAC: $20/user** (assuming 50% organic, 30% paid, 20% affiliate)

#### **Lifetime Value (LTV)**
- Average subscription: 12 months (5% monthly churn)
- ARPU: $20/month
- Gross margin: 42%
- **LTV: $20 × 12 × 0.42 = $100.80**

#### **LTV:CAC Ratio**
- $100.80 / $20 = **5.04:1**
- Target: >3:1 (healthy SaaS business)
- **Break-even: 2.4 months**

### Financial Projections (Conservative)

#### **Year 1**
- Users: 10,000 (paid)
- MRR: $200k
- ARR: $2.4M
- Costs: $1.4M (LLM: $960k, infra: $240k, support: $120k, other: $80k)
- **Net profit: $1M (42% margin)**

#### **Year 2**
- Users: 30,000 (paid) + 5 enterprise
- MRR: $650k
- ARR: $7.8M
- Costs: $4M (LLM: $2.88M, sales team: $400k, infra: $600k, support: $360k, other: $760k)
- **Net profit: $3.8M (49% margin)**

#### **Year 3**
- Users: 75,000 (paid) + 50 enterprise
- MRR: $2M
- ARR: $24M
- Costs: $12M (LLM: $7.2M, team: $3M, infra: $1.5M, support: $900k, other: $900k)
- **Net profit: $12M (50% margin)**

### Risk Analysis

#### **High Risk**
1. **LLM cost volatility**: Model pricing changes could compress margins
   - **Mitigation**: Multi-provider strategy, own model routing logic
2. **Browser API changes**: Manifest V3 deprecations, API removals
   - **Mitigation**: Abstraction layers, fallback mechanisms
3. **Competitive moat**: Large tech companies (Google, Microsoft) could replicate
   - **Mitigation**: Move fast, build ecosystem, focus on power users

#### **Medium Risk**
1. **User adoption**: Market education required (what is AI automation?)
   - **Mitigation**: Strong content marketing, viral demos
2. **Churn**: Users may subscribe, try once, cancel
   - **Mitigation**: Onboarding flows, engagement triggers, habit formation
3. **Support burden**: Complex product, many edge cases
   - **Mitigation**: Self-service docs, AI-powered support bot, community forum

#### **Low Risk**
1. **Technical execution**: Core technology proven (pi-ai framework)
2. **Payment processing**: Standard Stripe integration
3. **Security**: Standard extension security practices

### Key Success Metrics

#### **Product Metrics**
- **Activation rate**: % of installs that complete first automation
- **Retention**: D1, D7, D30 active user rates
- **Power users**: % of users with >50 messages/month
- **NPS**: Net Promoter Score (target: >50)

#### **Business Metrics**
- **MRR growth**: Month-over-month recurring revenue growth
- **CAC payback**: Months to recover acquisition cost
- **Churn rate**: Monthly cancellation rate (target: <5%)
- **Expansion revenue**: Top-ups and upgrades

#### **Technical Metrics**
- **Tool success rate**: % of tool executions that succeed
- **Response time**: P50, P95, P99 latency for responses
- **Error rate**: % of conversations with errors
- **Uptime**: Extension availability (target: 99.9%)

---

## Strategic Questions for Business Model Refinement

### 1. **Pricing Strategy**
- Is $20/month the right price point? (vs. $10, $15, $30)
- Should we offer annual plans with discount? (e.g., $200/year = $16.67/month)
- Should top-ups be cheaper per message than base plan? (encourage growth)

### 2. **Quota Design**
- Is 500 messages/month too high? (most users won't hit it)
- Should we count tool executions separately? (complex billing)
- Should we offer "rollover" messages? (use it or lose it vs. bank it)

### 3. **Free Tier Strategy**
- Should free tier exist? (acquisition vs. support burden)
- If yes, 50 messages enough to hook users?
- Should free tier have feature restrictions? (e.g., no debugger tool, no artifacts)

### 4. **Market Positioning**
- Developer tool (deep, technical) vs. Productivity tool (broad, accessible)?
- Premium niche (high price, low volume) vs. Mass market (low price, high volume)?
- Horizontal (all use cases) vs. Vertical (focus on 2-3 industries first)?

### 5. **Growth Levers**
- Should we incentivize skill creation? (pay creators, bounties)
- Referral program? (give 1 month free for each referral)
- Should we be App Store or Walled Garden? (open ecosystem vs. curated)

### 6. **Enterprise Motion**
- When to introduce enterprise tier? (Year 1 vs. Year 2)
- Should enterprise be self-serve or sales-assisted?
- Minimum contract size? ($500/month vs. $5000/month)

### 7. **Cost Optimization**
- Should we fine-tune our own models? (upfront cost, long-term savings)
- Cache more aggressively? (storage cost vs. LLM cost tradeoff)
- Offer "slow mode" with cheaper models? (budget-conscious users)

### 8. **Defensibility**
- Patent browser automation techniques? (hard to enforce)
- Build strong brand early? (marketing spend)
- Lock users in with data/workflows? (risky, anti-user)

---

## Conclusion

Sitegeist represents a new category: **Conversational Browser Automation**. It combines the accessibility of ChatGPT with the power of RPA tools, delivered in a browser-native package.

**Key Business Insights:**
1. **Large TAM**: Millions of knowledge workers who browse the web
2. **Strong unit economics**: 5:1 LTV:CAC ratio, 42% margin
3. **Defensible moat**: Browser-native architecture, skill ecosystem
4. **Multiple revenue streams**: Subscriptions, top-ups, marketplace, enterprise
5. **Scalable**: Low marginal cost per user, high automation potential

**Next Steps:**
1. Launch free tier, build to 1,000 active users
2. Validate pricing with early adopters
3. Refine tool reliability and UX based on feedback
4. Begin content marketing and SEO optimization
5. Prepare paid tier launch with Stripe integration

**Success depends on:**
- Execution speed (beat big tech to market)
- Product quality (tool reliability, UX polish)
- Market education (show, don't tell)
- Community building (evangelists who create skills)

With the right execution, Sitegeist can become the de facto AI companion for web power users, capturing a meaningful share of the $240M+ market opportunity.
