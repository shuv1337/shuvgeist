export const tutorials = [
	{
		label: "What is Shuvgeist?",
		prompt: `You are about to help a non-technical user understand Shuvgeist through an interactive tutorial. Guide them step-by-step through Shuvgeist's capabilities.

**CRITICAL RULES:**
- Keep explanations SHORT (2-3 sentences max)
- After EACH step, STOP and wait for them to say continue
- When clicking or typing, ALWAYS scroll element into view first
- Never move to next step until they confirm

**START:** First tell them to drag this panel wider by its left edge to see outputs better. STOP and wait for them to confirm.

**PHASE 1: Browse & Extract**
Step 1: Navigate to google.com, explain what happened. STOP.
Step 2: Type "chocolate chip cookie recipe" in search box, tell them what happened, ask if they see it. STOP.
Step 3: Click search button, explain. STOP.
Step 4: Extract top results using your google search skill (don't explain skills yet), show them the results. STOP.

Then ask if they're ready for Phase 2. STOP.

**PHASE 2: Multi-Step Automation**
Step 1: Explain that recipe sites are awful (ads everywhere) and manually compiling recipes is tedious. I can navigate multiple sites, collect info, and output clean documents (markdown, PDF, Word, HTML). You'll demonstrate by collecting 2 recipes from top results. STOP.
Step 2: Wait for their go-ahead, then visit 2 recipe sites, extract data from each, create a markdown artifact with both recipes formatted nicely. Explain each step as you go. STOP.

Then ask if they're ready for Phase 3. STOP.

**PHASE 3: Output Formats**
Step 1: Explain that now you have the recipe data, you can output in any format they want. STOP.
Step 2: Create artifacts in this order, explaining each after creation:
- Markdown (already done)
- PDF version (STOP after creating)
- Word document version (STOP after creating)
- Interactive HTML with ingredient calculator for each recipe (they can input how many cookies they want, ingredients scale automatically) (STOP after creating)
Step 3: After all artifacts, explain that markdown/HTML are best for iterative work since you can update them fastest (unlike PDF/Word which must be regenerated). STOP.

Then ask if they're ready for Phase 4. STOP.

**PHASE 4: Skills**
Step 1: Explain that doing everything ad-hoc works but is slow. Better to teach you about a site collaboratively, then save that knowledge as a "skill". Next time that site is visited, you instantly know how to interact with it. (Give relatable example like: "Instead of figuring out Amazon's search every time, a skill remembers it"). STOP.
Step 2: Demo an existing skill - the YouTube skill. Search for latest Veritasium video, get transcript using YouTube skill, create markdown with video beats (each beat: title, start/end timestamp, summary). STOP.

Then ask if they're ready for Phase 5. STOP.

**PHASE 5: Sky's the Limit**
Explain that this is just scratching the surface. I can:
- Research topics/companies/people and compile living dossiers
- Automate form filling across multiple sites
- Monitor prices and track changes over time
- Extract data from dozens of pages automatically
- Combine data from multiple sources into custom reports

STOP.

**File Attachments:**
Explain: "I currently can't see images on web pages, but you can attach files to our chat that I can read and work with. This is useful for showing me what you see on a page - just take a screenshot and attach it!"

List what you can work with:
- **Images/Screenshots**: See what's on your screen, extract text (OCR), describe content, guide interactions
- **PDFs, Word, Excel**: Read, extract data, cross-reference with web data
- **Code files**: Analyze any text-based files

Tell them: "Use the attachment button in the chat input to attach files or simply drag and drop the files into the chat area. You can also paste images directly from your clipboard into the chat input."

STOP.

**Interface Overview:**
Explain the UI elements:

**Header (top, left to right):**
- Session history icon → Find and resume old chat sessions
- New session icon → Start fresh
- Session title field → Click to rename the current session
- Theme toggle → Switch between system/light/dark theme
- Settings icon → Configure API keys, skills, proxy settings

**Message Editor (bottom):**
- Attachment icon → Attach files to chat
- Thinking settings (if model supports it) → Off/minimal/low/medium/high. When on, I think before acting, which improves results but takes longer and costs more
- Model selector → Pick different AI models. If you have Ollama running locally (https://ollama.com), you can select from your local models, so everything is truly local
- Submit/Stop button → Send message or stop me (can also press ESCAPE key while focused on this sidepanel)

STOP.

**Data Privacy:**
Explain where data is stored and who gets what:
- **Settings & API keys**: Stored locally on your computer only
- **Sessions & attachments**: Stored locally on your computer only
- **When you send messages**: All text and attachments in the chat session are sent to the LLM provider (default: Anthropic). They're configured to not retain your data or use it for training
- **CORS proxy**: Some subscription logins (Anthropic, GitHub Copilot) and providers (Z-AI) require a CORS proxy. Configure your proxy URL in Settings > Proxy. See the project README for instructions on running your own proxy

STOP.

Ask what they'd like to try or explore next.`,
	},
	{
		label: "Research Profile",
		prompt:
			"Ask me who I want you to research and what I know about them (provide a single sentence like 'John Doe - software developer, works at Google'). Once I provide the person and context, use the repl tool with navigate() and browserjs() to search Google and systematically research them. Find their social media, academic history, professional work history, personal interests, passions, family life, birth date, contact details, location, news articles, and whatever else you can find. For each promising page you discover, navigate to it and extract the full content. Throughout the research process, create a markdown artifact early and continuously update it with findings (add links so I can check sources). When research is complete, analyze everything and update the artifact with a final section on what would work in a cold email and what to avoid. I need a personal hook, something they'll react to, not corporate slop.",
	},
	{
		label: "Analyze YouTube Video",
		prompt:
			"Find the newest Veritasium video. Identify beats and their start and end timestamp, and summarize each beat. Then give me an executive summary for the whole video. Finally, ask me if i want to jump to a specific beat or if I want an explanation what's currently being said in the video.",
	},
	{
		label: "Compare Prices",
		prompt:
			"Create skills for shop.billa.at and spar.at to search for products. The goal is to create a simple function that allows you to scrape the current search result page's products including images. Use the ask_user_which_element tool whenever you're unsure which element is the search box, submit button, or product cards - don't hesitate to ask for visual confirmation. Follow the skills workflow - break it down into small steps we test together using repl with browserjs(): 1) Find search input field (ask me to point it out if unclear), add text, and confirm with me the text is there. Use 'Schokolade' as the search term, so we get many results later when we try to figure out paging. 2) Try submitting (enter key or button click), and ask me if it worked. 3) Extract product name/image URL/packaging/price from results. Use ask_user_which_element to have me point out a product card if the structure isn't clear. 4) Page through results using UI (ask me to point out pagination if needed). Iterate based on my feedback. Once each skill works, save it. Then use both skills to search for Mikado and create an artifact comparing prices across both stores.",
	},
	{
		label: "GitHub Trending to Sheets",
		prompt:
			"Go to GitHub trending page, scrape the top 10 repos (name, language, stars, forks, description) and save that to trending.json artifact. Then, create a blank Google Sheet (can be done with URL navigation). Finally, output a formatted Google Sheets table with a blue header containing the trending repos data.",
	},
	{
		label: "LinkedIn Engagement",
		prompt:
			"Check my last 3 LinkedIn posts for unanswered comments and give me suggestions what I could answer. For each unanswered comment, consider the original post content and the full comment thread context to generate relevant replies. Suggest 2-3 response options with different tones (professional, casual, humorous) so I can pick what fits best.",
	},
];
