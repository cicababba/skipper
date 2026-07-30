// Shared chrome: sidebar nav, status bar, generic actions. EN is the master
// shape; the other languages must mirror its keys exactly.

const en = {
  nav: {
    inbox: "Inbox",
    drafts: "Drafts",
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
  toast: {
    dismiss: "Dismiss",
  },
  language: {
    title: "Language",
    subtitle: "Skipper follows your system language unless you pick one explicitly.",
    auto: "Auto (system)",
    autoDesc: "Detected from your computer's language",
  },
};

const it: typeof en = {
  nav: {
    inbox: "Inbox",
    drafts: "Bozze",
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
  toast: {
    dismiss: "Ignora",
  },
  language: {
    title: "Lingua",
    subtitle: "Skipper segue la lingua di sistema, salvo scelta esplicita.",
    auto: "Auto (sistema)",
    autoDesc: "Rilevata dalla lingua del computer",
  },
};

const fr: typeof en = {
  nav: {
    inbox: "Inbox",
    drafts: "Brouillons",
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
  toast: {
    dismiss: "Ignorer",
  },
  language: {
    title: "Langue",
    subtitle: "Skipper suit la langue du système, sauf choix explicite.",
    auto: "Auto (système)",
    autoDesc: "Détectée depuis la langue de l'ordinateur",
  },
};

const es: typeof en = {
  nav: {
    inbox: "Inbox",
    drafts: "Borradores",
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
  toast: {
    dismiss: "Descartar",
  },
  language: {
    title: "Idioma",
    subtitle: "Skipper sigue el idioma del sistema, salvo elección explícita.",
    auto: "Auto (sistema)",
    autoDesc: "Detectado del idioma del equipo",
  },
};

export const common = { en, it, fr, es };
