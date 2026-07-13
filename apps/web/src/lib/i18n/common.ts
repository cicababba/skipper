// Shared chrome: sidebar nav, status bar, generic actions. EN is the master
// shape; the other languages must mirror its keys exactly.

const en = {
  nav: {
    inbox: "Inbox",
    wiki: "Wiki",
    mindMap: "Mind Map",
    search: "Search",
    ask: "Ask",
    ingest: "Ingest",
    knowledge: "Knowledge",
    health: "Health",
    insights: "Insights",
    modules: "Modules",
    settings: "Settings",
  },
  actions: {
    save: "Save",
    cancel: "Cancel",
    close: "Close",
    delete: "Delete",
    rename: "Rename",
    create: "Create",
    confirm: "Confirm",
    retry: "Retry",
    back: "Back",
    open: "Open",
    copy: "Copy",
    refresh: "Refresh",
  },
  statusBar: {
    terminal: "Terminal",
    showTerminal: "Show terminal",
    hideTerminal: "Hide terminal",
  },
  theme: {
    switchToLight: "Switch to light mode",
    switchToDark: "Switch to dark mode",
  },
  language: {
    title: "Language",
    subtitle: "NestBrain follows your system language unless you pick one explicitly.",
    auto: "Auto (system)",
    autoDesc: "Detected from your computer's language",
  },
};

const it: typeof en = {
  nav: {
    inbox: "Inbox",
    wiki: "Wiki",
    mindMap: "Mind Map",
    search: "Cerca",
    ask: "Chiedi",
    ingest: "Ingerisci",
    knowledge: "Knowledge",
    health: "Salute",
    insights: "Insights",
    modules: "Moduli",
    settings: "Impostazioni",
  },
  actions: {
    save: "Salva",
    cancel: "Annulla",
    close: "Chiudi",
    delete: "Elimina",
    rename: "Rinomina",
    create: "Crea",
    confirm: "Conferma",
    retry: "Riprova",
    back: "Indietro",
    open: "Apri",
    copy: "Copia",
    refresh: "Aggiorna",
  },
  statusBar: {
    terminal: "Terminale",
    showTerminal: "Mostra terminale",
    hideTerminal: "Nascondi terminale",
  },
  theme: {
    switchToLight: "Passa al tema chiaro",
    switchToDark: "Passa al tema scuro",
  },
  language: {
    title: "Lingua",
    subtitle: "NestBrain segue la lingua di sistema, salvo scelta esplicita.",
    auto: "Auto (sistema)",
    autoDesc: "Rilevata dalla lingua del computer",
  },
};

const fr: typeof en = {
  nav: {
    inbox: "Inbox",
    wiki: "Wiki",
    mindMap: "Mind Map",
    search: "Recherche",
    ask: "Demander",
    ingest: "Ingérer",
    knowledge: "Knowledge",
    health: "Santé",
    insights: "Insights",
    modules: "Modules",
    settings: "Réglages",
  },
  actions: {
    save: "Enregistrer",
    cancel: "Annuler",
    close: "Fermer",
    delete: "Supprimer",
    rename: "Renommer",
    create: "Créer",
    confirm: "Confirmer",
    retry: "Réessayer",
    back: "Retour",
    open: "Ouvrir",
    copy: "Copier",
    refresh: "Actualiser",
  },
  statusBar: {
    terminal: "Terminal",
    showTerminal: "Afficher le terminal",
    hideTerminal: "Masquer le terminal",
  },
  theme: {
    switchToLight: "Passer au thème clair",
    switchToDark: "Passer au thème sombre",
  },
  language: {
    title: "Langue",
    subtitle: "NestBrain suit la langue du système, sauf choix explicite.",
    auto: "Auto (système)",
    autoDesc: "Détectée depuis la langue de l'ordinateur",
  },
};

const es: typeof en = {
  nav: {
    inbox: "Inbox",
    wiki: "Wiki",
    mindMap: "Mind Map",
    search: "Buscar",
    ask: "Preguntar",
    ingest: "Ingerir",
    knowledge: "Knowledge",
    health: "Salud",
    insights: "Insights",
    modules: "Módulos",
    settings: "Ajustes",
  },
  actions: {
    save: "Guardar",
    cancel: "Cancelar",
    close: "Cerrar",
    delete: "Eliminar",
    rename: "Renombrar",
    create: "Crear",
    confirm: "Confirmar",
    retry: "Reintentar",
    back: "Atrás",
    open: "Abrir",
    copy: "Copiar",
    refresh: "Actualizar",
  },
  statusBar: {
    terminal: "Terminal",
    showTerminal: "Mostrar terminal",
    hideTerminal: "Ocultar terminal",
  },
  theme: {
    switchToLight: "Cambiar a tema claro",
    switchToDark: "Cambiar a tema oscuro",
  },
  language: {
    title: "Idioma",
    subtitle: "NestBrain sigue el idioma del sistema, salvo elección explícita.",
    auto: "Auto (sistema)",
    autoDesc: "Detectado del idioma del equipo",
  },
};

export const common = { en, it, fr, es };
