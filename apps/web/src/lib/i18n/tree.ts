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
    moveToTrashFailed: "Move-to-trash failed",
    hardDeleteFailed: "Hard delete failed",
    open: "Open",
    rename: "Rename",
    delete: "Delete",
    moveToTrash: "Move to .trash/",
    deleteAllDevices: "Delete on all devices…",
    fileWord: "file",
    folderWord: "folder",
    deleteConfirm: (kind: string, name: string) => `Delete ${kind} "${name}"?`,
    deleteTrashNote:
      "This item is in .trash/ — deleting will remove it permanently from this device.",
    deleteFolderNote: "All its contents will be permanently removed.",
    cannotUndo: "This action cannot be undone.",
    hardDeleteTitle: "Delete on all devices?",
    hardDeleteBody1:
      "will be permanently removed from your Google Drive. Other devices signed in to NestBrain with this account will move their local copy to",
    hardDeleteBody2:
      "on their next sync — but the file will no longer be recoverable from Drive. This cannot be undone.",
    typeDeleteToConfirm: "Type DELETE to confirm",
    cancel: "Cancel",
    deleting: "Deleting…",
    deleteForever: "Delete forever",
    hardDeleteFolderUnsupported:
      "Folder hard-delete isn't supported yet — delete files individually.",
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
    moveToTrashFailed: "Spostamento in .trash/ non riuscito",
    hardDeleteFailed: "Eliminazione definitiva non riuscita",
    open: "Apri",
    rename: "Rinomina",
    delete: "Elimina",
    moveToTrash: "Sposta in .trash/",
    deleteAllDevices: "Elimina su tutti i dispositivi…",
    fileWord: "il file",
    folderWord: "la cartella",
    deleteConfirm: (kind: string, name: string) =>
      `Eliminare ${kind} "${name}"?`,
    deleteTrashNote:
      "Questo elemento è in .trash/ — l'eliminazione lo rimuoverà definitivamente da questo dispositivo.",
    deleteFolderNote: "Tutto il suo contenuto verrà rimosso definitivamente.",
    cannotUndo: "Questa azione non può essere annullata.",
    hardDeleteTitle: "Eliminare su tutti i dispositivi?",
    hardDeleteBody1:
      "verrà rimosso definitivamente dal tuo Google Drive. Gli altri dispositivi collegati a NestBrain con questo account sposteranno la loro copia locale in",
    hardDeleteBody2:
      "alla prossima sincronizzazione — ma il file non sarà più recuperabile da Drive. Questa azione non può essere annullata.",
    typeDeleteToConfirm: "Digita DELETE per confermare",
    cancel: "Annulla",
    deleting: "Eliminazione…",
    deleteForever: "Elimina per sempre",
    hardDeleteFolderUnsupported:
      "L'eliminazione definitiva delle cartelle non è ancora supportata — elimina i file singolarmente.",
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
    moveToTrashFailed: "Échec du déplacement vers .trash/",
    hardDeleteFailed: "Échec de la suppression définitive",
    open: "Ouvrir",
    rename: "Renommer",
    delete: "Supprimer",
    moveToTrash: "Déplacer vers .trash/",
    deleteAllDevices: "Supprimer sur tous les appareils…",
    fileWord: "le fichier",
    folderWord: "le dossier",
    deleteConfirm: (kind: string, name: string) =>
      `Supprimer ${kind} « ${name} » ?`,
    deleteTrashNote:
      "Cet élément est dans .trash/ — la suppression le retirera définitivement de cet appareil.",
    deleteFolderNote: "Tout son contenu sera définitivement supprimé.",
    cannotUndo: "Cette action est irréversible.",
    hardDeleteTitle: "Supprimer sur tous les appareils ?",
    hardDeleteBody1:
      "sera définitivement supprimé de votre Google Drive. Les autres appareils connectés à NestBrain avec ce compte déplaceront leur copie locale vers",
    hardDeleteBody2:
      "lors de leur prochaine synchronisation — mais le fichier ne sera plus récupérable depuis Drive. Cette action est irréversible.",
    typeDeleteToConfirm: "Tapez DELETE pour confirmer",
    cancel: "Annuler",
    deleting: "Suppression…",
    deleteForever: "Supprimer définitivement",
    hardDeleteFolderUnsupported:
      "La suppression définitive des dossiers n'est pas encore prise en charge — supprimez les fichiers un par un.",
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
    moveToTrashFailed: "No se pudo mover a .trash/",
    hardDeleteFailed: "No se pudo eliminar definitivamente",
    open: "Abrir",
    rename: "Renombrar",
    delete: "Eliminar",
    moveToTrash: "Mover a .trash/",
    deleteAllDevices: "Eliminar en todos los dispositivos…",
    fileWord: "el archivo",
    folderWord: "la carpeta",
    deleteConfirm: (kind: string, name: string) =>
      `¿Eliminar ${kind} "${name}"?`,
    deleteTrashNote:
      "Este elemento está en .trash/ — al eliminarlo se quitará permanentemente de este dispositivo.",
    deleteFolderNote: "Todo su contenido se eliminará permanentemente.",
    cannotUndo: "Esta acción no se puede deshacer.",
    hardDeleteTitle: "¿Eliminar en todos los dispositivos?",
    hardDeleteBody1:
      "se eliminará permanentemente de tu Google Drive. Los demás dispositivos conectados a NestBrain con esta cuenta moverán su copia local a",
    hardDeleteBody2:
      "en su próxima sincronización — pero el archivo ya no se podrá recuperar desde Drive. Esta acción no se puede deshacer.",
    typeDeleteToConfirm: "Escribe DELETE para confirmar",
    cancel: "Cancelar",
    deleting: "Eliminando…",
    deleteForever: "Eliminar para siempre",
    hardDeleteFolderUnsupported:
      "La eliminación definitiva de carpetas aún no está disponible — elimina los archivos uno a uno.",
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
