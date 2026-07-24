# Direzione di prodotto

> Documento di visione e decisioni. Non è una spec tecnica: fotografa **cosa stiamo
> costruendo, perché, e quali scelte abbiamo già preso**. Nasce come pivot della base
> di codice NestBrain.

---

## In una riga

**Una inbox unica per tutte le issue assegnate a te — su GitHub, GitLab, Jira —
dove ogni issue arriva già con un piano, un punteggio di confidence e la
possibilità di svilupparla con un agente che ti consegna una PR ovunque viva il
codice (Bitbucket incluso) e la accompagna fino al merge.**

Non è "un altro coding agent". È il **livello di triage e orchestrazione che sta
sopra** gli agenti. Le mani (scrivere il codice) sono ormai commodity; il valore è il
**cervello**: decidere cosa vale la pena fare, come, con quanta fiducia — e portarlo
a casa.

---

## Per chi (wedge iniziale)

**Il power-user singolo**: chi ha davvero issue sparse su più piattaforme —
consulenti, agenzie, maintainer OSS, chi ha un lavoro più i side project. Una
persona, una macchina, più account. È il wedge che l'architettura senza backend
serve alla perfezione.

Il team (coda condivisa, stato multi-utente, metriche) è la destinazione di v4, non
il punto di partenza. Il posizionamento parla al singolo finché l'architettura è
quella del singolo.

---

## Cos'è / Cosa non è

| È | Non è |
|---|---|
| Un cruscotto del lavoro in volo su più piattaforme | Un altro editor / IDE |
| Un orchestratore che pianifica, sviluppa e sorveglia le PR | Un agente di coding scritto da zero |
| Un giudice che ti dice *quali* issue affidare all'AI | Una wiki di documenti da alimentare a mano |
| Un'app desktop che parla direttamente con le piattaforme | Un servizio con backend proprio |

---

## Il ciclo di vita (il cuore del prodotto)

Ogni issue è un'entità che si muove attraverso degli stati — alcuni in automatico,
altri con un tuo via libera.

```
  NUOVA / TRIAGE ──auto──▶ PLANNING ──▶ confidence?
   (scoperta o                            │
    creata da te)              alta ──────┼────── bassa
                                │                   │
                                │          GATE PIANO (tu approvi
                                │            o correggi il piano)
                                │                   │
                                └────────┬──────────┘
                                         ▼
                                     IN CODA ──slot libero──▶ CODING
                                                          (worktree + agente)
                                                                 │
                                                                 ▼
                                                      AGENT-REVIEW (max 2 giri)
                                                        │ ok         │ non converge
                                                        ▼            ▼
                                                REVIEW UMANA      SERVE INPUT
                                                (diff in-app,
                                                 editabile)
                                                        │
                                                        ▼
   FATTA / MERGED ◀── IN REVIEW ◀──────────── PR APERTA (bottone; da qui
        ▲              │                       si vive sulla piattaforma)
        │        MODIFICHE RICHIESTE ──▶ (rientra in CODING con priorità:
        │              │                  stesso worktree, affronta i
        └──────────────┘                  commenti e ripusha)

   stati laterali: BLOCCATA / SERVE INPUT (confidence bassa) · FALLITA
```

Quattro principi guida:

1. **Planning eager.** Appena una issue arriva o la crei, il piano parte da solo in
   background. Quando apri l'app, la card è già "pronta", non "da fare".
2. **Gate mobile, guidato dalla confidence.** La confidence non regola solo la
   severità del gate: decide *dove sta l'umano* nel flusso. Confidence alta → si
   salta il gate sul piano, il coding parte, l'umano rivede solo il diff alla fine.
   Confidence bassa → ci si ferma **sul piano** e lo si corregge *prima* di bruciare
   tempo-macchina. Mai due gate obbligatori: sarebbe micromanagement.
3. **PR shepherding.** Aprire la PR non è la fine. L'app sorveglia la PR: se arrivano
   commenti o richieste di modifica, l'issue rientra in sviluppo, l'agente le
   affronta nello stesso worktree e ripusha. Non "spara e dimentica": accompagna.
4. **WIP limitato.** Il lavoro in volo è esplicitamente limitato (vedi "Coda"):
   l'app non si trasforma in una fabbrica fuori controllo di worktree e token.

---

## Cosa può fare l'utente

- **Collegare più account** (GitHub, poi GitLab, Jira, Bitbucket).
- **Vedere in un colpo solo** tutte le issue assegnate, ovunque siano.
- **Creare issue** dall'app stessa (vedi sezione dedicata).
- **Approvare / editare i piani** quando la confidence lo richiede.
- **Sviluppare** un'issue con un click: worktree isolato + agente → diff → PR bozza.
- **Rivedere ed editare il diff in-app** prima di aprire la PR.
- **Seguire lo stato** di tutto e **monitorare le PR** con i loro giri di review.
- **Mettere in pausa l'intake** di nuove issue e **regolare la coda** di lavoro.
- **Consultare cosa è stato fatto** (vedi "Memoria" sotto).

---

## Navigazione

```
┌─ SIDEBAR ────────┐  ┌─ MAIN ──────────────────────────┐
│ ★ Tutto          │  │  [ Tabella | Kanban ]  toggle    │
│                  │  │  ⏸ nuove issue in pausa · coda 2/2│
│ GitHub           │  │                                  │
│  · api-server    │  │  issue · stato · confidence · PR │
│  · web-app       │  │  ...                             │
│ Bitbucket        │  │                                  │
│  · legacy-svc    │  │                                  │
│ Jira             │  │                                  │
│  · PROJ-X →repo  │  │                                  │
└──────────────────┘  └──────────────────────────────────┘
```

- **Sidebar per progetto/repo** come spina organizzativa; è anche la casa di
  "collega account", "aggiungi repo" e delle impostazioni per-repo (incluso
  l'auto-plan: on / off / solo-label).
- **"Tutto" pinnato in cima**: la vista aggregata cross-piattaforma. È *obbligatoria*,
  non un extra — è proprio il differenziatore ("una coda sola per tutto"). La lista
  repo è un **filtro**, non un cancello.
- **Doppia vista, stesso dato:**
  - **Tabella** → scala e scansione: ordina/filtra per confidence, repo, età, stato
    PR; azioni in bulk. Vista di default per chi gestisce volume.
  - **Kanban** → flusso: "cosa c'è in volo adesso", dove si ingorga il lavoro.
- **Gli stati di pausa e la coda sono sempre visibili in topbar/tray** e reversibili
  in un gesto. Chi pausa deve sapere di averlo fatto (pattern Dropbox/Syncthing).

---

## Provider: due assi (IssueSource / CodeHost)

Una "piattaforma" per noi significava tre cose insieme: chi ti assegna l'issue, dove
vive il codice, dove va la PR. GitHub le collassa in una; GitLab pure. Jira le separa —
una issue Jira non ha un repo. E siccome Jira + GitHub è una combinazione più comune
di Jira + Bitbucket, una issue Jira deve poter puntare a *qualsiasi* code host dal
giorno uno: il disaccoppiamento non è opzionale. Da qui il modello a due assi
(epic #68):

- **IssueSource** — da dove arrivano le issue: polling delle issue assegnate,
  cursore, delta sync. GitHub, GitLab, Jira.
- **CodeHost** — dove vive il codice: base per il worktree, apertura PR/MR, polling
  di review e CI. GitHub, GitLab, Bitbucket.
- **WorkItem = issue + repo collegato.** Il legame è derivato automaticamente per
  GitHub/GitLab (l'issue vive nel repo); per Jira è un mapping esplicito
  project→repo, configurato una volta in settings.

Le decisioni fissate in #68:

- **Read-only v1.** Nessun write-back verso il tracker: niente transizioni Jira,
  niente sync di stato, niente commenti. Per commentare si apre l'issue nel browser.
  Tiene bassi lo scope e gli scope OAuth di scrittura.
- **Il mapping project→repo vive in settings**, non al gate del piano:
  deterministico, zero attrito a runtime, non rompe l'auto-coding sopra
  `confidence.high`. L'ammissione scarta le issue dei progetti non mappati.
- **Bitbucket entra solo come CodeHost.** Bitbucket Issues è fuori scope (non lo usa
  quasi nessuno); il suo valore è completare la storia Jira.
- **`repoKey` resta ancorata al repo, mai al tracker.** È l'asse di partizione della
  memoria delle soluzioni; ancorarla a un progetto Jira spartirebbe la memoria nel
  modo sbagliato.
- **Target: GitLab, Jira, Bitbucket.** Linear e gli altri sono esplicitamente
  rimandati.

Per chi scrive un provider nuovo: gli adapter vivono in `packages/core` dietro i due
port (estratti dall'attuale `github/` con #69–#71); gli account OAuth passano dal
registro `PROVIDERS` in `apps/desktop/src/auth/`.

---

## Runtime degli agenti: il terzo asse (multi-CLI) — epic #236

La decisione #1 (orchestrare, non costruire un agente proprio) resta; quello che
cambia è che "l'agente" smette di essere per forza Claude Code. Il modello di
prodotto — si spawna la CLI che l'utente già possiede, si usa il suo abbonamento,
zero API key — generalizza: Codex CLI, Copilot CLI e Gemini CLI hanno tutte una
modalità headless con la stessa forma (print mode, stream di eventi JSON, resume
delle sessioni, gating dei tool, MCP). E mescolare i vendor per ruolo — pianificare
con Claude, scrivere codice con Codex, review con Copilot — è un differenziatore che
nessun tool single-vendor può offrire.

Le decisioni fissate in #236:

- **Contratto `AgentRuntime` con capability matrix esplicita**
  (`streaming / resume / confinement / mcp`) al posto dei commenti "claude-cli only".
  L'orchestratore degrada in modo deliberato su una capability assente: senza
  `resume` → sessione fresca + recap dal transcript che Skipper già possiede negli
  eventi; senza `mcp` → run senza memoria delle soluzioni.
- **Le sessioni non si trasferiscono tra runtime.** Coder e rientro-shepherd sono lo
  stesso runtime per costruzione; il record di sessione porta il runtime che l'ha
  creata, e un cambio a metà vita degrada a recap invece di resume.
- **La selezione per-ruolo riusa il pattern dei modelli**: `plannerRuntime` /
  `coderRuntime` / `reviewerRuntime` accanto ai campi `*Model`, stessa scala
  per-repo → globale → default.
- **Primo secondo runtime: Codex CLI** — parità di capability più alta (exec
  headless, stream JSON, resume, sandbox nativo `workspace-write` che *semplifica*
  il confinement invece di complicarlo).
- Gli eventi si normalizzano nello schema `CodingEvent` esistente via parser di
  stream per-runtime; le instructions per-repo (#227) sono già agnostiche (testo nel
  system prompt, doc Skipper-owned).

---

## Il punteggio di confidence (il differenziatore)

Non è l'LLM che dice "sono sicuro al 90%". È un punteggio **composto e verificabile**,
che serve a dirti *prima di partire* quali issue vale la pena affidare all'AI:

- **Groundedness** — i file/simboli citati nel piano esistono davvero nel repo?
- **Convergenza** — più piani indipendenti concordano? Se divergono, l'issue è
  ambigua e te lo dice.
- **Critic** — un secondo agente prova a demolire il piano.
- **Chiarezza dell'issue** — ci sono criteri di accettazione / repro, o è vaga?
- **Memoria** — somiglia a qualcosa già risolto e mergiato pulito (confidence su) o a
  qualcosa poi revertito (bandiera di rischio)?

La confidence è **azionabile** in senso letterale: **sposta il gate umano**. Alta →
niente gate sul piano, l'umano rivede solo il diff. Bassa → ci si ferma sul piano e
lo si corregge prima di spendere. Il numero sulla card decide fisicamente dove
intervieni.

Nota di sequenza: groundedness, convergenza e critic **non dipendono dalla memoria**
e sono disponibili dal giorno zero — vanno in v1, non aspettano il volume.

---

## Review: prima l'agente, poi l'umano

Dopo il coding, un **agente reviewer** rivede il diff prima di disturbarti:

- **Contesto fresco**: il reviewer non eredita il framing di chi ha scritto il
  codice (stessi occhi = stessi punti ciechi). Rivede **contro i criteri di
  accettazione dell'issue**, non contro "sembra ok".
- **Massimo 2 giri**: se non converge, l'issue non torna indietro in silenzio —
  esce come **SERVE INPUT** con il motivo. La non-convergenza *è* un segnale di
  confidence, non un errore.
- **Tre modalità in settings: sempre / mai / auto.** "Auto" decide con criteri
  meccanici e spiegabili, non chiedendo a un LLM "serve review?": dimensione e
  natura del diff, file storicamente "caldi" (memoria), test verdi al primo colpo,
  confidence del piano di partenza. Se salta la review, l'app dice perché.
- Plan-critic (nel confidence) e code-reviewer (qui) sono **lo stesso componente
  avversariale con due punti di innesto**, non due sistemi.

Poi la **review umana, in-app**: pre-PR il codice esiste solo nel worktree locale,
quindi il diff si guarda nell'editor di NestBrain (diff view, file tree sul
worktree, terminale se vuoi metterci le mani) — e si può **editare direttamente**
prima di aprire la PR, senza un altro giro di agente. Dall'apertura della PR in poi
(bottone → link) si vive sulla piattaforma: l'app **monitora** e riporta lo stato
sulla card, non replica l'UI di GitHub.

---

## Creazione issue dall'app

Non è una feature minore: chiude il cerchio del "punto unico". Senza, l'app è una
*inbox* (reattiva); con, è il *punto d'origine* del lavoro — "mi è venuto in mente
X" → 30 secondi → l'issue esiste sulla piattaforma e il piano sta già girando.

- L'issue creata **vive sulla piattaforma** (GitHub/Jira), mai in un database
  nostro. L'app è la penna, non l'archivio.
- La creazione è il posto dove **prevenire le issue vaghe** invece di penalizzarle
  dopo: l'app propone criteri di accettazione, chiede il repo target, segnala
  "somiglia a [[issue già risolta]]" (memoria in retrieval). Le issue create
  dall'app nascono già ad alta confidence — e la differenza si vede nella colonna
  confidence: il prodotto si auto-dimostra.

---

## Esecuzione: background, coda, pausa

**Split background.** L'app in background/tray fa solo lavoro *economico e
interrompibile*: scoperta issue, planning eager + confidence, monitoraggio PR. Il
coding (worktree + agente) è *sempre* dietro un via libera e gira in foreground.
Il background non scrive mai codice da solo.

**Coda di coding (WIP limit).** Il limite visibile all'utente è uno: *quante issue
in sviluppo insieme* (configurabile, default basso). Il planning ha un limite
interno ma non serve esporlo.

- **Default: 1 coding per repo.** Due agenti sullo stesso repo = merge conflict
  quasi garantiti tra le loro PR. Il parallelismo è *tra* repo. Alzabile, ma il
  default sicuro è 1.
- Le issue approvate senza slot stanno **IN CODA**, ordinata per: (1) **rientri**
  (PR con modifiche richieste — finire ciò che è in volo batte iniziare cose
  nuove), (2) **pin manuale**, (3) **priorità del repo**, (4) **confidence**, poi
  **età**.
- **Priorità per repo.** Quando il WIP limit è conteso tra più repo, una priorità
  per-repo (alta/normale/bassa, default normale — in Settings accanto a follow
  list e auto-plan) decide quale coda prende lo slot libero. Il pin manuale resta
  l'override per-issue.
- I rientri **contano nel limite** (occupano un agente vero) ma saltano la coda.

**Pausa intake.** Un toggle globale ferma l'*ammissione* di nuove issue in inbox;
tutto ciò che è in volo continua (piani, coding, PR shepherding). È il WIP limit
sull'ingresso: "non aggiungermi lavoro", senza rompere nessuna promessa.

- Sotto il cofano il polling continua (deve: PR e issue in corso). La pausa è un
  **filtro sull'ingresso**, non uno stop allo scheduler.
- **Rito di rientro**: alla ripresa le issue accumulate entrano in TRIAGE e l'app
  chiede una volta sola — "12 nuove issue durante la pausa: pianificarle tutte /
  solo alcune / scelgo io" — per evitare un burst di spesa non voluto.

**Auto-plan per-repo.** Separato dalla pausa (che è globale e temporanea), ogni
repo ha un'impostazione strutturale: auto-plan **on / off / solo con label** (es.
`ai-ready`) — il filtro anti-rumore per i repo che non meritano planning
automatico. Con auto-plan off le issue entrano comunque in inbox, in TRIAGE, con
un bottone "Pianifica" manuale: la pausa degrada il prodotto da proattivo a
on-demand, non lo spegne.

---

## Memoria delle soluzioni + wiki

Ogni issue completata viene salvata come `problema → piano → diff → esito`. Questo
corpus serve **due padroni con un solo archivio**:

- **Per la macchina (retrieval):** quando arriva un'issue simile a lavoro già fatto,
  si inietta quel contesto → l'agente va più dritto (meno token), rifà le cose nello
  stesso modo (più consistenza), e la somiglianza alimenta la confidence.
- **Per l'utente (wiki):** lo stesso archivio, reso leggibile, diventa un
  **diario di ingegneria auto-documentato** — "cosa abbiamo fatto, come, perché".
  Utile per onboarding ed evitare di rifare cose.

Due regole per non ricadere nel vecchio prodotto:
- Il wiki è un **render** di lavoro già catturato, **non** una pipeline che ingerisce
  sorgenti arbitrarie. Zero input manuale.
- **Cattura dal giorno 1, retrieval quando c'è volume.** Il valore cresce nel tempo;
  all'inizio l'archivio è vuoto (cold start), quindi la plumbing va messa presto ma
  non ci si aspetta magia subito.

### Forma v2 — decisioni operative (#41)

La forma della memoria v2 è fissata nell'epic #41. In sintesi:

- **Retrieval solo via MCP.** Gli agenti (planner e coder) recuperano dalla memoria
  tramite un server MCP `skipper-memory` (`search_memory` / `get_memory`). La
  pre-iniezione lato Skipper nel prompt del planner è stata **scartata**: niente campo
  `memoriesUsed` nello schema del piano — le "memorie usate" si derivano dagli eventi di
  tool-use osservati (verità a terra, niente auto-dichiarazione). Si rivaluta solo se
  l'uso reale mostra che il planner non cerca mai.
- **Server MCP come subcomando CLI** (`skipper memory serve`), lanciato dal bundle CLI
  impacchettato col runtime dell'app (`ELECTRON_RUN_AS_NODE`) — nessuna dipendenza dal PATH.
- **I knowledge atoms restano un canale separato.** L'indice v2 contiene solo
  `SolutionRecord`; l'eventuale fusione si riconsidera dopo che il retrieval funziona.
- **Loop di feedback.** 👍/👎 al punto d'uso persiste sul record e pesa nel ranking
  (coseno × recency × feedback); la curatela deliberata vive nel memory browser del
  dettaglio repo.
- **Superficie dettaglio repo.** I repo diventano first-class nella navigazione; alle
  impostazioni di intake si aggiunge un override del WIP per-repo.

### Knowledge esterna (server MCP) — epic #235

La memoria locale non è l'unica knowledge utile al planning: le aziende hanno wiki
interne, doc di architettura, runbook. Skipper può collegarsi a un **server di
knowledge esterno**, e il planner lo consulta mentre raffina il piano. Forma decisa:

- **Via MCP, non API custom** — stesso pattern agent-pull della decisione #19: il
  planner cerca da sé quando capisce cosa gli serve, niente pre-iniezione; l'uso si
  deriva dagli eventi di tool-use e potrà alimentare la confidence. Il CLI `claude`
  supporta nativamente server MCP remoti: lato Skipper è una entry nel `--mcp-config`
  già costruito per `skipper-memory`, zero client HTTP da scrivere. E un server MCP
  aziendale serve qualsiasi client MCP, non solo Skipper — più facile da giustificare
  in azienda.
- **Opt-in: definizione a livello app, attach per-repo** — il server si definisce una
  volta (nome, URL, auth) e si collega ai repo che ne beneficiano; i repo senza
  server collegati si comportano esattamente come oggi.
- **Nessuna tensione con la decisione #4**: Skipper resta un client senza backend —
  il server lo ospita l'azienda, come "i server sono le piattaforme" per i tracker.
- I knowledge atoms locali restano un canale separato (#41), ma il seam generalizza:
  quando avranno una API di ricerca, `skipper knowledge serve` può diventare il
  reference server che un'azienda ospita.

### Indice del codice (Graphify) — issue #233

Il planner esplora un repo che non conosce: grep trova testo, non struttura. Con la
#233 ogni repo può avere (opt-in, toggle nelle impostazioni repo) un **indice
knowledge-graph locale** costruito da [Graphify](https://github.com/Graphify-Labs/graphify)
— parsing AST tree-sitter, deterministico, nessun LLM e nessuna API key
(`extract --code-only`). Scelte chiave:

- **Accesso via MCP** (`graphify-mcp`, allowlist dei soli 7 tool locali sul grafo),
  terza incarnazione del pattern agent-pull delle decisioni #19/#24 — stessa entry
  nel `--mcp-config` già costruito per `skipper-memory`.
- **Planner-only, by construction**: il server non è attaccato alle run del coder —
  il grafo riflette il base branch e diventerebbe falso rispetto alle sue modifiche.
- **Estrazione da un worktree usa-e-getta al base ref risolto**, mai dal checkout
  dell'utente (che può essere sporco o su un altro branch); output solo in userData.
- **Re-index lazy su SHA e mai bloccante**: il grafo stale si usa dichiarando i due
  SHA nel prompt ("è una mappa, verifica sul codice"); nessun grafo → si pianifica
  senza. Il piano eager resta il valore, il grafo è un aiuto.
- **Runtime Python isolato via uv** in userData (binario uv in `extraResources`,
  `graphifyy[mcp]` pinnata): nessuna dipendenza dal Python di sistema.

---

## Decisioni prese

| # | Decisione | Perché |
|---|-----------|--------|
| 1 | **Orchestrare Claude Code**, non costruire un agente proprio | Le mani sono commodity; costruirle è mesi di lavoro e ci mette contro Cursor/Devin. Orchestrare = valore in giorni. |
| 2 | **Gate mobile guidato dalla confidence** | Alta → si salta il gate sul piano, review umana solo sul diff. Bassa → ci si ferma sul piano prima di spendere. Mai due gate obbligatori. |
| 3 | **Prodotto vendibile da subito** | OAuth multi-account robusto e architettura pronta a scalare fin dall'inizio. |
| 4 | **Niente backend / Team Server** | I "server" sono le piattaforme (GitHub/Jira/…). Stato = piattaforme + manifest locale. Polling invece di webhook per partire. |
| 5 | **Via la pipeline wiki come prodotto**, ma **si tiene l'infra embeddings** | Riusata come *memoria delle soluzioni*, non come knowledge base da alimentare a mano. |
| 6 | **Il wiki torna come lente umana** sulla memoria | Sottoprodotto quasi gratis, auto-generato, utile per consultazione. |
| 7 | **Doppia vista tabella + kanban** | Due lenti sullo stesso stato: tabella per la scala, kanban per il flusso. |
| 8 | **Navigazione repo-first con "Tutto" pinnato** | Organizzazione per repo, ma la vista aggregata resta l'ingresso di default (è il moat). |
| 9 | **Wedge iniziale: power-user singolo** | Una persona, una macchina, più account: l'architettura senza backend calza a pennello. Il team è v4. |
| 10 | **Split background: tray = fetch/plan/monitor, coding sempre gated** | In background solo lavoro economico e interrompibile; il lavoro costoso è sempre visto e approvato. |
| 11 | **Reviewer agente: max 2 giri, modalità sempre/mai/auto** | Niente loop infiniti; non-convergenza → SERVE INPUT. "Auto" decide con criteri meccanici spiegabili. |
| 12 | **Review umana in-app pre-PR; piattaforma post-PR** | Pre-PR il codice esiste solo nel worktree (diff editabile nell'editor). Post-PR si riusa l'UI della piattaforma, l'app monitora. |
| 13 | **Creazione issue dall'app come flusso primario** | Chiude il cerchio del punto unico e previene le issue vaghe alla fonte. L'issue vive sulla piattaforma, mai da noi. |
| 14 | **Pausa intake con rito di rientro** | Ferma l'ammissione di nuove issue, non il lavoro in volo. Alla ripresa, niente burst di planning senza consenso. |
| 15 | **Coda di coding con WIP limit configurabile, default 1 per repo** | Controllo costi e conflitti. Priorità: rientri > pin > confidence > età. I rientri contano nel limite ma saltano la coda. |
| 16 | **Confidence "cheap" (groundedness, convergenza, critic) già in v1** | Non dipendono dalla memoria, disponibili dal giorno zero — è ciò che distingue v1 da un wrapper. |
| 17 | **Pricing early access: $29 one-time "founder"** (binari firmati, updates inclusi) | Playbook NestBrain già rodato (Polar merchant of record + upload CI + repo releases privato), zero infra licenze. Benefit license-key di Polar attivo dal giorno 1 per riconoscere i founder quando arriverà il modello definitivo. Il modello a regime (subscription con perpetual fallback? free/paid sul confine dell'aggregazione?) si decide con calma entro la v3. |
| 18 | **Confine open-core ridisegnato: git + terminale = core pubblico** (issue #1) | Il loop git (worktree, diff, stage, commit, push) e il terminale (finestra sull'agente + intervento manuale) sono il cuore del prodotto — non possono stare dietro il modulo Dev privato. Il git backend è riscritto nel tree pubblico (`apps/desktop/src/git.ts`); il terminale segue in un issue dedicato. Restano gated: Projects, team, metriche, multi-agent parallelism. |
| 19 | **Retrieval memoria solo via MCP** (server `skipper-memory`, no pre-iniezione nel prompt) — epic #41 | Gli agenti cercano da sé (`search_memory`/`get_memory`); niente campo `memoriesUsed` nel piano, le "memorie usate" si derivano dagli eventi di tool-use osservati (verità a terra, no auto-dichiarazione). Il server gira come subcomando CLI (`skipper memory serve`) col runtime dell'app (`ELECTRON_RUN_AS_NODE`) — nessuna dipendenza dal PATH. |
| 20 | **Modello provider a due assi: IssueSource / CodeHost** — epic #68 | "Piattaforma" conflava chi dà l'issue, dove vive il codice e dove va la PR. Jira le separa (una issue Jira non ha repo) e Jira+GitHub è più comune di Jira+Bitbucket: una issue deve poter puntare a qualsiasi code host. WorkItem = issue + repo collegato. |
| 21 | **Read-only v1 verso i tracker** | Nessun write-back (transizioni, stato, commenti): si commenta aprendo l'issue nel browser. Tiene bassi lo scope e gli scope OAuth di scrittura. |
| 22 | **Mapping project→repo in settings; Bitbucket solo CodeHost** | Mapping una tantum, deterministico, non rompe l'auto-coding sopra `confidence.high`; l'ammissione scarta i progetti non mappati. Bitbucket Issues fuori scope: il suo valore è completare la storia Jira. |
| 23 | **`repoKey` ancorata al repo, mai al tracker** | È l'asse di partizione della memoria delle soluzioni; ancorarla al progetto Jira spartirebbe la memoria nel modo sbagliato. |
| 24 | **Knowledge esterna via server MCP, opt-in per repo** — epic #235 | Agent-pull coerente con la #19 (niente pre-iniezione, uso derivato dal tool-use); entry nel `--mcp-config` esistente, zero client HTTP; il server lo ospita l'azienda (nessun backend Skipper, coerente con la #4). Definizione a livello app, attach per-repo: i repo senza server si comportano come oggi. |
| 25 | **Runtime degli agenti multi-CLI dietro il contratto `AgentRuntime`** — epic #236 | Estende la #1: si orchestra sempre, ma la CLI non è per forza Claude Code (Codex, Copilot, Gemini). Capability matrix esplicita con degradazione deliberata (no resume → recap; no MCP → senza memoria); selezione per-ruolo col pattern dei modelli; primo adapter: Codex CLI. I token restano dell'utente, qualunque sia il vendor. |
| 26 | **Indice knowledge-graph locale (Graphify) opt-in per repo, planner-only** — issue #233 | Grep trova testo, non struttura: il grafo (tree-sitter, locale, no LLM) dà al planner una mappa del repo → piani eager e confidence migliori. Accesso via MCP (pattern #19/#24, allowlist dei 7 tool locali); il coder è escluso by construction (grafo = base branch, andrebbe stale sulle sue modifiche). Estrazione da worktree effimero al base ref, re-index lazy su SHA, mai bloccante (stale dichiarato nel prompt). Runtime uv isolato in userData, pin `graphifyy[mcp]`. |

---

## Cosa riusiamo / cosa tagliamo (dalla base NestBrain)

**Si riusa (base già solida):**
- Shell desktop che sa lanciare l'agente (con i fix di ambiente già risolti).
- Terminale integrato + editor + file tree per vedere l'agente lavorare e rivedere i
  diff (è la review umana pre-PR).
- Il flusso OAuth desktop (stesso schema per GitHub/GitLab/Jira/Bitbucket).
- L'infra embeddings/retrieval → riconvertita in memoria delle soluzioni.
- Il pattern "osserva → riconcilia → traccia stato" → riconvertito in orchestratore.
- Il packaging firmato e lo schema open-core (utile per la parte vendibile).

**Si taglia:**
- La pipeline di ingest e compilazione della wiki come prodotto.
- Il sync su Google Drive.
- Il Team Server come backend.

---

## Posizionamento

Il concorrente da battere non è Claude Code — è il **coding agent nativo delle
piattaforme** (es. GitHub) e i background agent tipo Cursor. Ma quelli sono
**single-platform** e **senza triage**.

> "Lavori su GitHub *e* Jira *e* Bitbucket. Una coda sola, una sola qualità di
> giudizio, PR ovunque. Smetti di saltare tra tab e di indovinare quali ticket
> dare all'AI."

L'aggregazione multi-piattaforma + la confidence è la parte che un vendor
single-platform non replica facilmente. Il moat non è solo l'aggregazione (un
integration play, copiabile): è l'aggregazione **+ giudizio verificabile**. E il
giudizio si può mostrare fin da v1.

---

## Direzione a fasi

- **v1 — l'anello + il giudizio:** GitHub, piano, gate mobile, coda, worktree,
  review agente + umana in-app, PR, shepherding. Con la confidence "cheap"
  (groundedness, convergenza, critic) già dentro: anche su un solo GitHub, nessun
  altro ti dice *prima di partire, in modo verificabile* quali issue affidare
  all'AI.
- **v2 — la memoria:** cattura `problema → piano → diff → esito` a regime, retrieval
  in planning solo via MCP (server `skipper-memory`, no pre-iniezione), segnale memoria
  nella confidence, assist alla creazione issue. Forma fissata in #41.
- **v3 — l'aggregazione:** il modello provider a due assi (IssueSource / CodeHost,
  epic #68): prima GitLab (valida l'asse code-host e il self-hosted), poi Jira +
  Bitbucket (valida il tracker senza repo; Bitbucket solo come code host).
  Read-only verso i tracker; Linear e gli altri esplicitamente rimandati. Qui
  nasce il moat vendibile.
- **v4 — il team:** più agenti in parallelo, coda condivisa, metriche (confidence
  media, PR accettate al primo giro), wiki di consultazione, gating enterprise.

---

## Da decidere più avanti

- ~~**Nome** del prodotto~~ — **deciso (2026-07-14): Skipper**, il codename del repo promosso
  a nome del prodotto (rename coordinato in #16).
- **Come si impone la licenza** (chiavi firmate verificate in locale vs micro-funzione
  serverless — comunque *non* un backend pieno). Le chiavi Polar del tier founder
  sono il punto di partenza.
- **Modello di pricing a regime** (da ripensare entro la v3, quando nasce il moat):
  subscription con perpetual fallback stile JetBrains/Obsidian vs one-time con major
  upgrade; dove passa il confine free/paid (candidato: loop GitHub single-agent
  gratis, aggregazione multi-piattaforma + parallelismo + team a pagamento — nota:
  implica adapter v3 nei moduli privati, si lega alla decisione sul confine
  open-core). Niente pricing a consumo: i token sono dell'utente.
- **Webhook vs polling** per il monitoraggio PR (si parte in polling).
- **Soglie di confidence**: cosa conta come "alta" (salta il gate) — fisso,
  configurabile, o adattivo sulla storia dell'utente.
- **Criteri esatti della modalità "auto"** del reviewer (pesi dei segnali meccanici).
- ~~**Mappatura tracker→repo** per Jira/Linear~~ — **deciso (#68/#79): mapping
  project→repo in settings**, una tantum; l'ammissione scarta le issue dei progetti
  non mappati.
