// composer surface dictionary (#136) — EN is the master shape; other languages
// must mirror its keys exactly. Covers the chat composer view, the draft cards
// and the repo picker behind the topbar "+".

const en = {
  newIssue: "New issue",
  title: "New issue",
  chatPlaceholder: "Describe the work…",
  emptyTitle: "Shape an issue",
  emptyHint:
    "Say what you want to change. The agent reads this repository before answering, and drafts the issues when you ask for them.",
  startFailed: "The composer could not start",

  generate: "Generate draft",
  regenerate: "Regenerate draft",
  generating: "Generating…",
  generateFailed: "Draft generation failed",
  regenTitle: "Regenerate over your edits?",
  regenBody:
    "You edited some fields by hand. The agent is asked to keep them word for word, but a regeneration can still change them.",
  regenConfirm: "Regenerate",
  cancel: "Cancel",

  draft: "Draft",
  issueN: (n: number) => `Issue ${n}`,
  fieldTitle: "Title",
  fieldBody: "Body",
  fieldAcceptance: "Acceptance criteria",
  fieldLabels: "Labels",
  criterionPlaceholder: "A criterion",
  addCriterion: "Add criterion",
  labelPlaceholder: "Add a label",
  remove: "Remove",
  preview: "Preview",
  edit: "Edit",
  relations: "Relations",
  relBlocks: (from: number, to: number) => `${from} blocks ${to}`,
  relPartOf: (from: number, to: number) => `${from} is part of ${to}`,
  relRelatesTo: (from: number, to: number) => `${from} relates to ${to}`,

  account: "Account",
  selfAssign: "Assign to me",
  selfAssignHint: "The issue will enter your inbox and be planned.",
  noLogin: "Your username could not be resolved — the issues are created unassigned.",
  noAccount: "No connected account can create issues for this repository.",
  create: "Create",
  creating: "Creating…",
  createdN: (n: number) => `#${n} created`,
  createFailed: "Creation failed",
  retry: "Retry",
  openIssue: "Open on the tracker",
  allCreated: "Every issue was created.",

  quick: {
    modeChat: "Chat",
    modeQuick: "Quick",
    hint: "A title and a couple of lines, straight to the tracker — no agent, no draft.",
    leaveChatTitle: "Leave the conversation?",
    leaveChatBody:
      "Switching to the quick path ends this composer session — the conversation and any draft are lost.",
    leaveQuickTitle: "Discard this issue?",
    leaveQuickBody: "Switching to the chat path discards what you typed here.",
    leaveConfirm: "Switch",
  },

  picker: {
    title: "Pick a repository",
    desc: "The composer works inside a linked repository — it reads the local checkout.",
    empty: "No linked repository yet. Link one from Settings to compose issues.",
    cancel: "Cancel",
  },
};

const it: typeof en = {
  newIssue: "Nuova issue",
  title: "Nuova issue",
  chatPlaceholder: "Descrivi il lavoro…",
  emptyTitle: "Dai forma a una issue",
  emptyHint:
    "Racconta cosa vuoi cambiare. L'agente legge questo repository prima di rispondere, e redige le issue quando gliele chiedi.",
  startFailed: "Impossibile aprire il composer",

  generate: "Genera bozza",
  regenerate: "Rigenera bozza",
  generating: "Generazione…",
  generateFailed: "Generazione della bozza non riuscita",
  regenTitle: "Rigenerare sopra le tue modifiche?",
  regenBody:
    "Hai modificato dei campi a mano. All'agente viene chiesto di riportarli parola per parola, ma una rigenerazione può comunque cambiarli.",
  regenConfirm: "Rigenera",
  cancel: "Annulla",

  draft: "Bozza",
  issueN: (n: number) => `Issue ${n}`,
  fieldTitle: "Titolo",
  fieldBody: "Descrizione",
  fieldAcceptance: "Criteri di accettazione",
  fieldLabels: "Label",
  criterionPlaceholder: "Un criterio",
  addCriterion: "Aggiungi criterio",
  labelPlaceholder: "Aggiungi una label",
  remove: "Rimuovi",
  preview: "Anteprima",
  edit: "Modifica",
  relations: "Relazioni",
  relBlocks: (from: number, to: number) => `${from} blocca ${to}`,
  relPartOf: (from: number, to: number) => `${from} fa parte di ${to}`,
  relRelatesTo: (from: number, to: number) => `${from} è collegata a ${to}`,

  account: "Account",
  selfAssign: "Assegna a me",
  selfAssignHint: "La issue entrerà nel tuo inbox e verrà pianificata.",
  noLogin: "Non è stato possibile risalire al tuo username — le issue vengono create senza assegnatario.",
  noAccount: "Nessun account collegato può creare issue per questo repository.",
  create: "Crea",
  creating: "Creazione…",
  createdN: (n: number) => `#${n} creata`,
  createFailed: "Creazione non riuscita",
  retry: "Riprova",
  openIssue: "Apri sul tracker",
  allCreated: "Tutte le issue sono state create.",

  quick: {
    modeChat: "Chat",
    modeQuick: "Rapida",
    hint: "Un titolo e due righe, dritte al tracker — niente agente, niente bozza.",
    leaveChatTitle: "Uscire dalla conversazione?",
    leaveChatBody:
      "Passare alla modalità rapida chiude questa sessione del composer — la conversazione e l'eventuale bozza vanno perse.",
    leaveQuickTitle: "Scartare questa issue?",
    leaveQuickBody: "Passare alla chat scarta quello che hai scritto qui.",
    leaveConfirm: "Passa",
  },

  picker: {
    title: "Scegli un repository",
    desc: "Il composer lavora dentro un repository collegato — legge il checkout locale.",
    empty: "Nessun repository collegato. Collegane uno dalle Impostazioni per comporre le issue.",
    cancel: "Annulla",
  },
};

const fr: typeof en = {
  newIssue: "Nouvelle issue",
  title: "Nouvelle issue",
  chatPlaceholder: "Décrivez le travail…",
  emptyTitle: "Donnez forme à une issue",
  emptyHint:
    "Dites ce que vous voulez changer. L'agent lit ce dépôt avant de répondre, et rédige les issues quand vous le demandez.",
  startFailed: "Impossible d'ouvrir le composer",

  generate: "Générer le brouillon",
  regenerate: "Régénérer le brouillon",
  generating: "Génération…",
  generateFailed: "Échec de la génération du brouillon",
  regenTitle: "Régénérer par-dessus vos modifications ?",
  regenBody:
    "Vous avez modifié des champs à la main. L'agent est prié de les reprendre mot pour mot, mais une régénération peut malgré tout les changer.",
  regenConfirm: "Régénérer",
  cancel: "Annuler",

  draft: "Brouillon",
  issueN: (n: number) => `Issue ${n}`,
  fieldTitle: "Titre",
  fieldBody: "Description",
  fieldAcceptance: "Critères d'acceptation",
  fieldLabels: "Labels",
  criterionPlaceholder: "Un critère",
  addCriterion: "Ajouter un critère",
  labelPlaceholder: "Ajouter un label",
  remove: "Supprimer",
  preview: "Aperçu",
  edit: "Modifier",
  relations: "Relations",
  relBlocks: (from: number, to: number) => `${from} bloque ${to}`,
  relPartOf: (from: number, to: number) => `${from} fait partie de ${to}`,
  relRelatesTo: (from: number, to: number) => `${from} est liée à ${to}`,

  account: "Compte",
  selfAssign: "M'assigner l'issue",
  selfAssignHint: "L'issue entrera dans votre inbox et sera planifiée.",
  noLogin:
    "Votre nom d'utilisateur n'a pas pu être résolu — les issues sont créées sans assignation.",
  noAccount: "Aucun compte connecté ne peut créer d'issues pour ce dépôt.",
  create: "Créer",
  creating: "Création…",
  createdN: (n: number) => `#${n} créée`,
  createFailed: "Échec de la création",
  retry: "Réessayer",
  openIssue: "Ouvrir sur le tracker",
  allCreated: "Toutes les issues ont été créées.",

  quick: {
    modeChat: "Chat",
    modeQuick: "Rapide",
    hint: "Un titre et deux lignes, directement sur le tracker — pas d'agent, pas de brouillon.",
    leaveChatTitle: "Quitter la conversation ?",
    leaveChatBody:
      "Passer au mode rapide met fin à cette session du composer — la conversation et le brouillon éventuel sont perdus.",
    leaveQuickTitle: "Abandonner cette issue ?",
    leaveQuickBody: "Passer au mode chat abandonne ce que vous avez écrit ici.",
    leaveConfirm: "Basculer",
  },

  picker: {
    title: "Choisissez un dépôt",
    desc: "Le composer travaille dans un dépôt lié — il lit la copie locale.",
    empty: "Aucun dépôt lié pour l'instant. Liez-en un depuis les Paramètres pour composer des issues.",
    cancel: "Annuler",
  },
};

const es: typeof en = {
  newIssue: "Nueva issue",
  title: "Nueva issue",
  chatPlaceholder: "Describe el trabajo…",
  emptyTitle: "Da forma a una issue",
  emptyHint:
    "Cuenta qué quieres cambiar. El agente lee este repositorio antes de responder, y redacta las issues cuando se lo pidas.",
  startFailed: "No se pudo abrir el composer",

  generate: "Generar borrador",
  regenerate: "Regenerar borrador",
  generating: "Generando…",
  generateFailed: "No se pudo generar el borrador",
  regenTitle: "¿Regenerar sobre tus cambios?",
  regenBody:
    "Has editado algunos campos a mano. Se le pide al agente que los reproduzca palabra por palabra, pero una regeneración aún puede cambiarlos.",
  regenConfirm: "Regenerar",
  cancel: "Cancelar",

  draft: "Borrador",
  issueN: (n: number) => `Issue ${n}`,
  fieldTitle: "Título",
  fieldBody: "Descripción",
  fieldAcceptance: "Criterios de aceptación",
  fieldLabels: "Labels",
  criterionPlaceholder: "Un criterio",
  addCriterion: "Añadir criterio",
  labelPlaceholder: "Añadir una label",
  remove: "Quitar",
  preview: "Vista previa",
  edit: "Editar",
  relations: "Relaciones",
  relBlocks: (from: number, to: number) => `${from} bloquea a ${to}`,
  relPartOf: (from: number, to: number) => `${from} forma parte de ${to}`,
  relRelatesTo: (from: number, to: number) => `${from} se relaciona con ${to}`,

  account: "Cuenta",
  selfAssign: "Asignármela",
  selfAssignHint: "La issue entrará en tu inbox y se planificará.",
  noLogin: "No se pudo resolver tu nombre de usuario — las issues se crean sin asignar.",
  noAccount: "Ninguna cuenta conectada puede crear issues para este repositorio.",
  create: "Crear",
  creating: "Creando…",
  createdN: (n: number) => `#${n} creada`,
  createFailed: "No se pudo crear",
  retry: "Reintentar",
  openIssue: "Abrir en el tracker",
  allCreated: "Se crearon todas las issues.",

  quick: {
    modeChat: "Chat",
    modeQuick: "Rápida",
    hint: "Un título y un par de líneas, directo al tracker — sin agente, sin borrador.",
    leaveChatTitle: "¿Salir de la conversación?",
    leaveChatBody:
      "Cambiar al modo rápido termina esta sesión del composer — se pierden la conversación y el borrador.",
    leaveQuickTitle: "¿Descartar esta issue?",
    leaveQuickBody: "Cambiar al modo chat descarta lo que has escrito aquí.",
    leaveConfirm: "Cambiar",
  },

  picker: {
    title: "Elige un repositorio",
    desc: "El composer trabaja dentro de un repositorio vinculado — lee la copia local.",
    empty: "Todavía no hay repositorios vinculados. Vincula uno desde Ajustes para componer issues.",
    cancel: "Cancelar",
  },
};

export const composer = { en, it, fr, es };
