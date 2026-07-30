// drafts surface dictionary (#138) — EN is the master shape; other languages
// must mirror its keys exactly. Covers the /drafts list page.

const en = {
  title: "Drafts",
  subtitle: "Composer sessions you saved. Publishing a draft removes it from here.",
  untitled: "Untitled draft",
  unfinished: "unfinished",
  colDraft: "Draft",
  colRepo: "Repository",
  colUpdated: "Updated",
  colActions: "Actions",
  resume: "Resume",
  publish: "Publish",
  delete: "Delete",
  deleteConfirm: "Delete this draft?",
  deleteYes: "Delete",
  deleteNo: "Keep",
  empty: "No saved drafts.",
  emptyHint: "Save a composer conversation to pick it up later, on this machine.",
  desktopOnly: "Drafts are available in the desktop app.",
};

const it: typeof en = {
  title: "Bozze",
  subtitle: "Le sessioni del compositore che hai salvato. Pubblicare una bozza la rimuove da qui.",
  untitled: "Bozza senza titolo",
  unfinished: "non finita",
  colDraft: "Bozza",
  colRepo: "Repository",
  colUpdated: "Aggiornata",
  colActions: "Azioni",
  resume: "Riprendi",
  publish: "Pubblica",
  delete: "Elimina",
  deleteConfirm: "Eliminare questa bozza?",
  deleteYes: "Elimina",
  deleteNo: "Mantieni",
  empty: "Nessuna bozza salvata.",
  emptyHint: "Salva una conversazione del compositore per riprenderla più tardi, su questa macchina.",
  desktopOnly: "Le bozze sono disponibili nell'app desktop.",
};

const fr: typeof en = {
  title: "Brouillons",
  subtitle: "Les sessions du compositeur que vous avez enregistrées. Publier un brouillon le retire d'ici.",
  untitled: "Brouillon sans titre",
  unfinished: "inachevée",
  colDraft: "Brouillon",
  colRepo: "Dépôt",
  colUpdated: "Mis à jour",
  colActions: "Actions",
  resume: "Reprendre",
  publish: "Publier",
  delete: "Supprimer",
  deleteConfirm: "Supprimer ce brouillon ?",
  deleteYes: "Supprimer",
  deleteNo: "Conserver",
  empty: "Aucun brouillon enregistré.",
  emptyHint: "Enregistrez une conversation du compositeur pour la reprendre plus tard, sur cette machine.",
  desktopOnly: "Les brouillons sont disponibles dans l'application de bureau.",
};

const es: typeof en = {
  title: "Borradores",
  subtitle: "Las sesiones del compositor que guardaste. Publicar un borrador lo quita de aquí.",
  untitled: "Borrador sin título",
  unfinished: "sin terminar",
  colDraft: "Borrador",
  colRepo: "Repositorio",
  colUpdated: "Actualizado",
  colActions: "Acciones",
  resume: "Retomar",
  publish: "Publicar",
  delete: "Eliminar",
  deleteConfirm: "¿Eliminar este borrador?",
  deleteYes: "Eliminar",
  deleteNo: "Conservar",
  empty: "No hay borradores guardados.",
  emptyHint: "Guarda una conversación del compositor para retomarla más tarde, en esta máquina.",
  desktopOnly: "Los borradores están disponibles en la aplicación de escritorio.",
};

export const drafts = { en, it, fr, es };
