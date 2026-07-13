// tree surface dictionary — EN is the master shape; other languages must
// mirror its keys exactly. Covers file tree, topbar, update toast, sync
// indicator and compile indicator.

const en = {
  files: {
    newFileTitle: "New file in selected folder",
    newFolderTitle: "New folder in selected folder",
    newFileIn: "New file in",
    newFolderIn: "New folder in",
    filePlaceholder: "filename.md",
    folderPlaceholder: "folder-name",
    invalidName: "Invalid name",
    createFailed: "Failed to create",
    renameFailed: "Rename failed",
    deleteFailed: "Delete failed",
    open: "Open",
    rename: "Rename",
    delete: "Delete",
    fileWord: "file",
    folderWord: "folder",
    deleteConfirm: (kind: string, name: string) => `Delete ${kind} "${name}"?`,
    deleteFolderNote: "All its contents will be permanently removed.",
    cannotUndo: "This action cannot be undone.",
    cancel: "Cancel",
    fileRowTitle: "Double-click to open · Right-click for options",
    empty: "empty",
  },
  projects: {
    newProject: "New project",
    newProjectTitle: "Create a new project in NestBrain/Projects",
    import: "Import",
    importTitle:
      "Import an existing folder into Projects — made knowledge-ready automatically",
    importFailed: "Import failed",
    makeReady: "Make knowledge-ready",
    makeReadyDone:
      "Project is now knowledge-ready — commits will feed the knowledge base.",
    makeReadyFailed: "Failed to make knowledge-ready",
    openTerminalTitle: (name: string) =>
      `Open terminal here · focus branch indicator on ${name}`,
  },
  topbar: {
    syncUnavailableTitle:
      "Drive sync requires the official build from nestbrain.app — or wire your own Google OAuth client (see README).",
    syncUnavailable: "Sync — not available in the free build",
    signInGoogle: "Sign in with Google",
    waitingBrowser: "Waiting for browser…",
    cancel: "Cancel",
    signInFailed: "Sign-in failed",
    retry: "Retry",
    accountSettings: "Sync & Account settings",
    signOut: "Sign out",
  },
  updates: {
    ready: "Update ready",
    downloaded: (version: string) =>
      `NestBrain ${version} has been downloaded. Restart to apply it now, or it will install automatically the next time you quit.`,
    restartNow: "Restart now",
    later: "Later",
  },
  sync: {
    paused: "Sync paused",
    off: "Sync off",
    error: "Sync error",
    scanning: "Scanning…",
    syncing: "Syncing",
    sync: "Sync",
    disabledTitle: "Sync is disabled",
    scanningWorkspace: "Scanning workspace…",
    inProgress: "Sync in progress",
    lastSync: (date: string) => `Last sync: ${date}`,
    idle: "Sync idle",
    filesProgress: (done: number, total: number) => `${done} of ${total} files`,
    skipped: (n: number) => ` (${n} skipped)`,
    syncNow: "Sync now",
    settings: "Settings",
  },
  compile: {
    ready: "Ready to compile",
    compiling: "Compiling...",
  },
};

const it: typeof en = {
  files: {
    newFileTitle: "Nuovo file nella cartella selezionata",
    newFolderTitle: "Nuova cartella nella cartella selezionata",
    newFileIn: "Nuovo file in",
    newFolderIn: "Nuova cartella in",
    filePlaceholder: "nomefile.md",
    folderPlaceholder: "nome-cartella",
    invalidName: "Nome non valido",
    createFailed: "Creazione non riuscita",
    renameFailed: "Rinomina non riuscita",
    deleteFailed: "Eliminazione non riuscita",
    open: "Apri",
    rename: "Rinomina",
    delete: "Elimina",
    fileWord: "il file",
    folderWord: "la cartella",
    deleteConfirm: (kind: string, name: string) =>
      `Eliminare ${kind} "${name}"?`,
    deleteFolderNote: "Tutto il suo contenuto verrà rimosso definitivamente.",
    cannotUndo: "Questa azione non può essere annullata.",
    cancel: "Annulla",
    fileRowTitle: "Doppio clic per aprire · Clic destro per le opzioni",
    empty: "vuota",
  },
  projects: {
    newProject: "Nuovo progetto",
    newProjectTitle: "Crea un nuovo progetto in NestBrain/Projects",
    import: "Importa",
    importTitle:
      "Importa una cartella esistente in Projects — resa knowledge-ready automaticamente",
    importFailed: "Importazione non riuscita",
    makeReady: "Rendi knowledge-ready",
    makeReadyDone:
      "Il progetto ora è knowledge-ready — i commit alimenteranno la knowledge base.",
    makeReadyFailed: "Impossibile rendere il progetto knowledge-ready",
    openTerminalTitle: (name: string) =>
      `Apri un terminale qui · indicatore branch su ${name}`,
  },
  topbar: {
    syncUnavailableTitle:
      "La sincronizzazione Drive richiede la build ufficiale da nestbrain.app — oppure configura il tuo client Google OAuth (vedi README).",
    syncUnavailable: "Sync — non disponibile nella build gratuita",
    signInGoogle: "Accedi con Google",
    waitingBrowser: "In attesa del browser…",
    cancel: "Annulla",
    signInFailed: "Accesso non riuscito",
    retry: "Riprova",
    accountSettings: "Impostazioni Sync e Account",
    signOut: "Esci",
  },
  updates: {
    ready: "Aggiornamento pronto",
    downloaded: (version: string) =>
      `NestBrain ${version} è stato scaricato. Riavvia per applicarlo subito, oppure verrà installato automaticamente alla prossima chiusura.`,
    restartNow: "Riavvia ora",
    later: "Più tardi",
  },
  sync: {
    paused: "Sync in pausa",
    off: "Sync disattivata",
    error: "Errore di sync",
    scanning: "Scansione…",
    syncing: "Sincronizzazione",
    sync: "Sync",
    disabledTitle: "La sincronizzazione è disattivata",
    scanningWorkspace: "Scansione del workspace…",
    inProgress: "Sincronizzazione in corso",
    lastSync: (date: string) => `Ultima sync: ${date}`,
    idle: "Sync inattiva",
    filesProgress: (done: number, total: number) => `${done} di ${total} file`,
    skipped: (n: number) => ` (${n} saltati)`,
    syncNow: "Sincronizza ora",
    settings: "Impostazioni",
  },
  compile: {
    ready: "Pronto per compilare",
    compiling: "Compilazione...",
  },
};

const fr: typeof en = {
  files: {
    newFileTitle: "Nouveau fichier dans le dossier sélectionné",
    newFolderTitle: "Nouveau dossier dans le dossier sélectionné",
    newFileIn: "Nouveau fichier dans",
    newFolderIn: "Nouveau dossier dans",
    filePlaceholder: "nomfichier.md",
    folderPlaceholder: "nom-dossier",
    invalidName: "Nom invalide",
    createFailed: "Échec de la création",
    renameFailed: "Échec du renommage",
    deleteFailed: "Échec de la suppression",
    open: "Ouvrir",
    rename: "Renommer",
    delete: "Supprimer",
    fileWord: "le fichier",
    folderWord: "le dossier",
    deleteConfirm: (kind: string, name: string) =>
      `Supprimer ${kind} « ${name} » ?`,
    deleteFolderNote: "Tout son contenu sera définitivement supprimé.",
    cannotUndo: "Cette action est irréversible.",
    cancel: "Annuler",
    fileRowTitle: "Double-clic pour ouvrir · Clic droit pour les options",
    empty: "vide",
  },
  projects: {
    newProject: "Nouveau projet",
    newProjectTitle: "Créer un nouveau projet dans NestBrain/Projects",
    import: "Importer",
    importTitle:
      "Importer un dossier existant dans Projects — rendu knowledge-ready automatiquement",
    importFailed: "Échec de l'import",
    makeReady: "Rendre knowledge-ready",
    makeReadyDone:
      "Le projet est désormais knowledge-ready — les commits alimenteront la base de connaissances.",
    makeReadyFailed: "Impossible de rendre le projet knowledge-ready",
    openTerminalTitle: (name: string) =>
      `Ouvrir un terminal ici · indicateur de branch sur ${name}`,
  },
  topbar: {
    syncUnavailableTitle:
      "La synchronisation Drive nécessite la build officielle de nestbrain.app — ou configurez votre propre client Google OAuth (voir README).",
    syncUnavailable: "Sync — indisponible dans la version gratuite",
    signInGoogle: "Se connecter avec Google",
    waitingBrowser: "En attente du navigateur…",
    cancel: "Annuler",
    signInFailed: "Échec de la connexion",
    retry: "Réessayer",
    accountSettings: "Paramètres Sync et Compte",
    signOut: "Se déconnecter",
  },
  updates: {
    ready: "Mise à jour prête",
    downloaded: (version: string) =>
      `NestBrain ${version} a été téléchargé. Redémarrez pour l'appliquer maintenant, sinon il s'installera automatiquement à la prochaine fermeture.`,
    restartNow: "Redémarrer maintenant",
    later: "Plus tard",
  },
  sync: {
    paused: "Sync en pause",
    off: "Sync désactivée",
    error: "Erreur de sync",
    scanning: "Analyse…",
    syncing: "Synchronisation",
    sync: "Sync",
    disabledTitle: "La synchronisation est désactivée",
    scanningWorkspace: "Analyse de l'espace de travail…",
    inProgress: "Synchronisation en cours",
    lastSync: (date: string) => `Dernière sync : ${date}`,
    idle: "Sync inactive",
    filesProgress: (done: number, total: number) =>
      `${done} sur ${total} fichiers`,
    skipped: (n: number) => ` (${n} ignorés)`,
    syncNow: "Synchroniser",
    settings: "Paramètres",
  },
  compile: {
    ready: "Prêt à compiler",
    compiling: "Compilation...",
  },
};

const es: typeof en = {
  files: {
    newFileTitle: "Nuevo archivo en la carpeta seleccionada",
    newFolderTitle: "Nueva carpeta en la carpeta seleccionada",
    newFileIn: "Nuevo archivo en",
    newFolderIn: "Nueva carpeta en",
    filePlaceholder: "nombrearchivo.md",
    folderPlaceholder: "nombre-carpeta",
    invalidName: "Nombre no válido",
    createFailed: "No se pudo crear",
    renameFailed: "No se pudo renombrar",
    deleteFailed: "No se pudo eliminar",
    open: "Abrir",
    rename: "Renombrar",
    delete: "Eliminar",
    fileWord: "el archivo",
    folderWord: "la carpeta",
    deleteConfirm: (kind: string, name: string) =>
      `¿Eliminar ${kind} "${name}"?`,
    deleteFolderNote: "Todo su contenido se eliminará permanentemente.",
    cannotUndo: "Esta acción no se puede deshacer.",
    cancel: "Cancelar",
    fileRowTitle: "Doble clic para abrir · Clic derecho para opciones",
    empty: "vacía",
  },
  projects: {
    newProject: "Nuevo proyecto",
    newProjectTitle: "Crea un nuevo proyecto en NestBrain/Projects",
    import: "Importar",
    importTitle:
      "Importa una carpeta existente en Projects — se vuelve knowledge-ready automáticamente",
    importFailed: "Error al importar",
    makeReady: "Hacer knowledge-ready",
    makeReadyDone:
      "El proyecto ya es knowledge-ready — los commits alimentarán la base de conocimiento.",
    makeReadyFailed: "No se pudo hacer knowledge-ready el proyecto",
    openTerminalTitle: (name: string) =>
      `Abrir una terminal aquí · indicador de branch en ${name}`,
  },
  topbar: {
    syncUnavailableTitle:
      "La sincronización con Drive requiere la build oficial de nestbrain.app — o configura tu propio cliente Google OAuth (ver README).",
    syncUnavailable: "Sync — no disponible en la versión gratuita",
    signInGoogle: "Iniciar sesión con Google",
    waitingBrowser: "Esperando al navegador…",
    cancel: "Cancelar",
    signInFailed: "Error al iniciar sesión",
    retry: "Reintentar",
    accountSettings: "Ajustes de Sync y Cuenta",
    signOut: "Cerrar sesión",
  },
  updates: {
    ready: "Actualización lista",
    downloaded: (version: string) =>
      `NestBrain ${version} se ha descargado. Reinicia para aplicarla ahora, o se instalará automáticamente la próxima vez que cierres la app.`,
    restartNow: "Reiniciar ahora",
    later: "Más tarde",
  },
  sync: {
    paused: "Sync en pausa",
    off: "Sync desactivada",
    error: "Error de sync",
    scanning: "Analizando…",
    syncing: "Sincronizando",
    sync: "Sync",
    disabledTitle: "La sincronización está desactivada",
    scanningWorkspace: "Analizando el espacio de trabajo…",
    inProgress: "Sincronización en curso",
    lastSync: (date: string) => `Última sync: ${date}`,
    idle: "Sync inactiva",
    filesProgress: (done: number, total: number) =>
      `${done} de ${total} archivos`,
    skipped: (n: number) => ` (${n} omitidos)`,
    syncNow: "Sincronizar ahora",
    settings: "Ajustes",
  },
  compile: {
    ready: "Listo para compilar",
    compiling: "Compilando...",
  },
};

export const tree = { en, it, fr, es };
