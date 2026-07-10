// modules + about dictionary — EN is the master shape; other languages must
// mirror its keys exactly. Covers the Modules page and the About dialog.

const en = {
  page: {
    title: "Modules",
    subtitle: "Add-ons active in this build. Each module brings its own settings.",
    none: "No modules are active in this build.",
    activeBadge: "active",
    noSettings: "No settings for this module yet.",
    fallbackTagline: "Module",
    taglines: {
      dev: "Integrated terminal, Git integration, Projects area, knowledge atoms from commits.",
      anatomize: "Business document intelligence — assessments, friction points, recommendations.",
    },
  },
  about: {
    tagline: "Your AI-powered second brain",
    close: "Close",
    createdBy: "Created by Mike Gazzaruso",
    rights: "© 2026 NextEpochs. All rights reserved.",
  },
};

const it: typeof en = {
  page: {
    title: "Moduli",
    subtitle: "Componenti aggiuntivi attivi in questa build. Ogni modulo porta le proprie impostazioni.",
    none: "Nessun modulo attivo in questa build.",
    activeBadge: "attivo",
    noSettings: "Questo modulo non ha ancora impostazioni.",
    fallbackTagline: "Modulo",
    taglines: {
      dev: "Terminale integrato, integrazione Git, area Projects, atomi di conoscenza dai commit.",
      anatomize: "Intelligence sui documenti aziendali — valutazioni, punti di attrito, raccomandazioni.",
    },
  },
  about: {
    tagline: "Il tuo secondo cervello potenziato dall'IA",
    close: "Chiudi",
    createdBy: "Creato da Mike Gazzaruso",
    rights: "© 2026 NextEpochs. Tutti i diritti riservati.",
  },
};

const fr: typeof en = {
  page: {
    title: "Modules",
    subtitle: "Modules complémentaires actifs dans cette build. Chaque module apporte ses propres réglages.",
    none: "Aucun module n'est actif dans cette build.",
    activeBadge: "actif",
    noSettings: "Ce module n'a pas encore de réglages.",
    fallbackTagline: "Module",
    taglines: {
      dev: "Terminal intégré, intégration Git, espace Projects, atomes de connaissance issus des commits.",
      anatomize: "Intelligence documentaire d'entreprise — évaluations, points de friction, recommandations.",
    },
  },
  about: {
    tagline: "Votre second cerveau propulsé par l'IA",
    close: "Fermer",
    createdBy: "Créé par Mike Gazzaruso",
    rights: "© 2026 NextEpochs. Tous droits réservés.",
  },
};

const es: typeof en = {
  page: {
    title: "Módulos",
    subtitle: "Complementos activos en esta build. Cada módulo trae su propia configuración.",
    none: "No hay módulos activos en esta build.",
    activeBadge: "activo",
    noSettings: "Este módulo aún no tiene configuración.",
    fallbackTagline: "Módulo",
    taglines: {
      dev: "Terminal integrado, integración con Git, área de Projects, átomos de conocimiento a partir de los commits.",
      anatomize: "Inteligencia sobre documentos de negocio — evaluaciones, puntos de fricción, recomendaciones.",
    },
  },
  about: {
    tagline: "Tu segundo cerebro impulsado por IA",
    close: "Cerrar",
    createdBy: "Creado por Mike Gazzaruso",
    rights: "© 2026 NextEpochs. Todos los derechos reservados.",
  },
};

export const modules = { en, it, fr, es };
