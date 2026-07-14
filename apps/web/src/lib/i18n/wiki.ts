// Editor + onboarding dictionary — EN is the master shape; other languages
// must mirror its keys exactly. (Named `wiki` for historical reasons; the
// wiki surface itself was retired — only the editor and onboarding survive.)

const en = {
  editor: {
    loadingEditor: "Loading editor…",
    loading: "Loading…",
    save: "Save",
    saveTitle: "Save (⌘S)",
    saved: "Saved",
    saveFailed: "Save failed",
    errNoPath: "No file path provided",
    errDesktopOnly: "Editor requires the desktop app",
    errReadFailed: "Failed to read file",
    binaryFile: "Binary file — not editable",
    tooLarge: (size: string) => `File too large to edit (${size})`,
    tooLargeHint: "The in-app editor is capped at 1 MB.",
    unsavedLeave: (name: string) =>
      `"${name}" has unsaved changes. Leave without saving?`,
    unsavedClose: (name: string) =>
      `"${name}" has unsaved changes. Close without saving?`,
    scrollLeft: "Scroll tabs left",
    scrollRight: "Scroll tabs right",
    unsavedDot: "Unsaved — click to close",
    close: "Close",
  },
  onboarding: {
    welcomeTitle: "Welcome to",
    welcomeDesc:
      "Your issue inbox and orchestration layer on top of coding agents. Let's get you set up in under a minute.",
    getStarted: "Get started",
    back: "← Back",
    providerTitle: "Pick your LLM provider",
    providerDesc:
      "Skipper needs an LLM for planning and knowledge extraction.",
    claudeDesc1: "Uses your Claude subscription via the official CLI (",
    claudeDesc2: "). No API key, no bans — fully supported.",
    openaiDesc: "Bring your own OpenAI API key. Pay‑as‑you‑go usage.",
    model: "Model",
    claudeAuth1: "Authenticated via your Claude CLI session. Run",
    claudeAuth2: "if needed.",
    apiKey: "API Key",
    loading: "Loading…",
    saving: "Saving…",
    saveContinue: "Save & continue",
    celebrateTitle: "You're all set!",
    celebrateDesc:
      "Skipper is ready. Link your repositories and let the issues flow in.",
  },
};

const it: typeof en = {
  editor: {
    loadingEditor: "Caricamento editor…",
    loading: "Caricamento…",
    save: "Salva",
    saveTitle: "Salva (⌘S)",
    saved: "Salvato",
    saveFailed: "Salvataggio non riuscito",
    errNoPath: "Nessun percorso file fornito",
    errDesktopOnly: "L'editor richiede l'app desktop",
    errReadFailed: "Impossibile leggere il file",
    binaryFile: "File binario — non modificabile",
    tooLarge: (size: string) =>
      `File troppo grande per essere modificato (${size})`,
    tooLargeHint: "L'editor integrato è limitato a 1 MB.",
    unsavedLeave: (name: string) =>
      `"${name}" ha modifiche non salvate. Uscire senza salvare?`,
    unsavedClose: (name: string) =>
      `"${name}" ha modifiche non salvate. Chiudere senza salvare?`,
    scrollLeft: "Scorri le schede a sinistra",
    scrollRight: "Scorri le schede a destra",
    unsavedDot: "Non salvato — clicca per chiudere",
    close: "Chiudi",
  },
  onboarding: {
    welcomeTitle: "Benvenuto in",
    welcomeDesc:
      "La tua inbox delle issue e livello di orchestrazione sopra i coding agent. Ti configuriamo in meno di un minuto.",
    getStarted: "Inizia",
    back: "← Indietro",
    providerTitle: "Scegli il tuo provider LLM",
    providerDesc:
      "Skipper ha bisogno di un LLM per il planning e l'estrazione di conoscenza.",
    claudeDesc1: "Usa il tuo abbonamento Claude tramite la CLI ufficiale (",
    claudeDesc2: "). Nessuna chiave API, nessun ban — pienamente supportato.",
    openaiDesc: "Usa la tua chiave API OpenAI. Pagamento a consumo.",
    model: "Modello",
    claudeAuth1: "Autenticato tramite la tua sessione Claude CLI. Esegui",
    claudeAuth2: "se necessario.",
    apiKey: "Chiave API",
    loading: "Caricamento…",
    saving: "Salvataggio…",
    saveContinue: "Salva e continua",
    celebrateTitle: "Tutto pronto!",
    celebrateDesc:
      "Skipper è pronto. Collega i tuoi repository e lascia arrivare le issue.",
  },
};

const fr: typeof en = {
  editor: {
    loadingEditor: "Chargement de l'éditeur…",
    loading: "Chargement…",
    save: "Enregistrer",
    saveTitle: "Enregistrer (⌘S)",
    saved: "Enregistré",
    saveFailed: "Échec de l'enregistrement",
    errNoPath: "Aucun chemin de fichier fourni",
    errDesktopOnly: "L'éditeur nécessite l'application de bureau",
    errReadFailed: "Impossible de lire le fichier",
    binaryFile: "Fichier binaire — non modifiable",
    tooLarge: (size: string) =>
      `Fichier trop volumineux pour être modifié (${size})`,
    tooLargeHint: "L'éditeur intégré est limité à 1 Mo.",
    unsavedLeave: (name: string) =>
      `« ${name} » contient des modifications non enregistrées. Quitter sans enregistrer ?`,
    unsavedClose: (name: string) =>
      `« ${name} » contient des modifications non enregistrées. Fermer sans enregistrer ?`,
    scrollLeft: "Faire défiler les onglets vers la gauche",
    scrollRight: "Faire défiler les onglets vers la droite",
    unsavedDot: "Non enregistré — cliquez pour fermer",
    close: "Fermer",
  },
  onboarding: {
    welcomeTitle: "Bienvenue dans",
    welcomeDesc:
      "Votre boîte de réception d'issues et couche d'orchestration au-dessus des agents de code. Configurons tout en moins d'une minute.",
    getStarted: "Commencer",
    back: "← Retour",
    providerTitle: "Choisissez votre fournisseur LLM",
    providerDesc:
      "Skipper a besoin d'un LLM pour la planification et l'extraction de connaissances.",
    claudeDesc1: "Utilise votre abonnement Claude via la CLI officielle (",
    claudeDesc2:
      "). Pas de clé API, pas de bannissement — entièrement pris en charge.",
    openaiDesc:
      "Apportez votre propre clé API OpenAI. Facturation à l'usage.",
    model: "Modèle",
    claudeAuth1: "Authentifié via votre session Claude CLI. Exécutez",
    claudeAuth2: "si nécessaire.",
    apiKey: "Clé API",
    loading: "Chargement…",
    saving: "Enregistrement…",
    saveContinue: "Enregistrer et continuer",
    celebrateTitle: "Tout est prêt !",
    celebrateDesc:
      "Skipper est prêt. Liez vos dépôts et laissez les issues arriver.",
  },
};

const es: typeof en = {
  editor: {
    loadingEditor: "Cargando editor…",
    loading: "Cargando…",
    save: "Guardar",
    saveTitle: "Guardar (⌘S)",
    saved: "Guardado",
    saveFailed: "Error al guardar",
    errNoPath: "No se proporcionó ninguna ruta de archivo",
    errDesktopOnly: "El editor requiere la aplicación de escritorio",
    errReadFailed: "No se pudo leer el archivo",
    binaryFile: "Archivo binario — no editable",
    tooLarge: (size: string) =>
      `Archivo demasiado grande para editar (${size})`,
    tooLargeHint: "El editor integrado está limitado a 1 MB.",
    unsavedLeave: (name: string) =>
      `"${name}" tiene cambios sin guardar. ¿Salir sin guardar?`,
    unsavedClose: (name: string) =>
      `"${name}" tiene cambios sin guardar. ¿Cerrar sin guardar?`,
    scrollLeft: "Desplazar pestañas a la izquierda",
    scrollRight: "Desplazar pestañas a la derecha",
    unsavedDot: "Sin guardar — haz clic para cerrar",
    close: "Cerrar",
  },
  onboarding: {
    welcomeTitle: "Bienvenido a",
    welcomeDesc:
      "Tu bandeja de issues y capa de orquestación sobre los agentes de código. Te configuramos en menos de un minuto.",
    getStarted: "Empezar",
    back: "← Atrás",
    providerTitle: "Elige tu proveedor de LLM",
    providerDesc:
      "Skipper necesita un LLM para la planificación y la extracción de conocimiento.",
    claudeDesc1: "Usa tu suscripción de Claude mediante la CLI oficial (",
    claudeDesc2: "). Sin clave API, sin bloqueos — totalmente soportado.",
    openaiDesc: "Trae tu propia clave API de OpenAI. Pago por uso.",
    model: "Modelo",
    claudeAuth1: "Autenticado mediante tu sesión de Claude CLI. Ejecuta",
    claudeAuth2: "si es necesario.",
    apiKey: "Clave API",
    loading: "Cargando…",
    saving: "Guardando…",
    saveContinue: "Guardar y continuar",
    celebrateTitle: "¡Todo listo!",
    celebrateDesc:
      "Skipper está listo. Vincula tus repositorios y deja que lleguen las issues.",
  },
};

export const wiki = { en, it, fr, es };
