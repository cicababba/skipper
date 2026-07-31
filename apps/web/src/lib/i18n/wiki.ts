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
    providerTitle: "Choose your coding agent",
    providerDesc:
      "The agent CLI that plans and writes the code. You can change it later in Settings — per role, and per repository.",
    runtime: "Agent CLI",
    model: "Model",
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
    providerTitle: "Scegli il tuo agente",
    providerDesc:
      "La CLI dell'agente che pianifica e scrive il codice. Puoi cambiarla in seguito nelle impostazioni — per ruolo e per repository.",
    runtime: "CLI dell'agente",
    model: "Modello",
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
    providerTitle: "Choisissez votre agent de code",
    providerDesc:
      "La CLI de l'agent qui planifie et écrit le code. Vous pourrez la changer plus tard dans les paramètres — par rôle et par dépôt.",
    runtime: "CLI de l'agent",
    model: "Modèle",
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
    providerTitle: "Elige tu agente de código",
    providerDesc:
      "La CLI del agente que planifica y escribe el código. Puedes cambiarla más tarde en los ajustes — por rol y por repositorio.",
    runtime: "CLI del agente",
    model: "Modelo",
    loading: "Cargando…",
    saving: "Guardando…",
    saveContinue: "Guardar y continuar",
    celebrateTitle: "¡Todo listo!",
    celebrateDesc:
      "Skipper está listo. Vincula tus repositorios y deja que lleguen las issues.",
  },
};

export const wiki = { en, it, fr, es };
