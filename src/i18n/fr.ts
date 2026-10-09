import type { Key } from "./index";

//   = espace insécable (avant « : » et « % » en typographie française).
export const fr: Record<Key, string> = {
  // ---- app chrome --------------------------------------------------------------
  "app.title": "Analyseur de fractionné",
  "app.tagline": "Fichier .fit Garmin → répétitions, récupérations, allure, distance",
  "app.description":
    "Déposez un fichier .fit Garmin et obtenez une détection précise du fractionné : efforts, récupérations, allure, distance, fréquence cardiaque. Fonctionne entièrement dans votre navigateur.",
  "app.privacy": "Fonctionne dans votre navigateur — rien n’est envoyé",
  "app.privacyTitle": "Le fichier est décodé et analysé localement par JavaScript dans cet onglet.",
  "app.theme": "Thème",
  "app.themeAria": "Basculer entre thème clair et thème sombre",
  "app.langAria": "Langue",
  "app.footer":
    "Les limites correspondent au point médian de chaque changement d’allure, trouvé par détection de ruptures sur le signal de vitesse à 1 Hz (ou reprises des tours de la montre). Les distances proviennent de la courbe de distance enregistrée à ces limites.",

  // ---- drop zone ----------------------------------------------------------------
  "drop.title": "Déposez un fichier .fit Garmin ici",
  "drop.help":
    "Exportez le fichier original depuis Garmin Connect (activité ⚙ → Exporter l’original) ou copiez-le depuis le dossier GARMIN/Activity de la montre. Tout est analysé localement dans cette page.",
  "drop.choose": "Choisir un fichier .fit",
  "drop.another": "Ouvrir un autre fichier…",
  "drop.anywhere": "ou déposez un fichier n’importe où sur la page",
  "drop.demos": "Pas de fichier sous la main ? Essayez une séance simulée :",
  "drop.analysing": "Analyse en cours…",
  "drop.analysingHelp": "Décodage du fichier FIT et détection des intervalles.",
  "drop.fileAria": "Choisir un fichier FIT Garmin",
  "demo.6x800": "6 × 800 m sur piste · séance programmée",
  "demo.8x400": "8 × 400 m · bouton tour",
  "demo.pyramid": "Pyramide 400–1200 m · sans tours",
  "demo.fartlek": "Fartlek 8 × 2 min",
  "demo.hills": "Répétitions de côtes",
  "demo.12x200": "12 × 200 m",
  "demo.simulated": "{name} (simulé)",

  // ---- errors / warnings / notes produced by the engine (Msg) ----------------------
  "err.notFit": "Ce fichier ne ressemble pas à un fichier FIT (en-tête .FIT manquant).",
  "err.decode": "Impossible de décoder le fichier FIT : {detail}",
  "err.noRecords":
    "Aucune donnée exploitable. Est-ce bien un fichier d’activité (et non un fichier d’entraînement, de parcours ou de réglages) ?",
  "err.noPaceData": "Ce fichier ne contient ni vitesse, ni distance, ni GPS : l’allure ne peut pas être analysée.",
  "err.generic": "Une erreur est survenue pendant l’analyse de ce fichier : {detail}",
  "warn.integrity":
    "Le contrôle d’intégrité FIT a échoué (fichier tronqué ou corrompu) ; utilisation de ce qui a pu être décodé.",
  "warn.decoderIssues": "Le décodeur FIT a signalé {count} problème(s) ; le fichier est peut-être partiellement corrompu.",
  "warn.multiSession": "Le fichier contient {count} séances ; analyse de la séance « {sport} ».",
  "warn.noSpeedDistance":
    "Aucune donnée de vitesse ou de distance dans ce fichier ; la détection par l’allure est impossible.",
  "note.distFromSpeed": "Distance reconstituée en intégrant la vitesse.",
  "note.distFromGps": "Distance reconstituée à partir des positions GPS.",
  "note.speedFromDist": "Vitesse déduite de la distance (pas de vitesse de l’appareil dans le fichier).",
  "note.lag":
    "La vitesse de l’appareil retarde d’environ {lag} s sur la courbe de distance ; les limites ont été compensées.",
  "note.hilly": "Parcours vallonné : les intervalles ont été segmentés sur l’allure ajustée à la pente.",
  "note.noAltitude":
    "Pas de données d’altitude dans ce fichier : l’allure ajustée à la pente est indisponible, l’allure brute est utilisée.",
  "note.lapUnavailable": "Mode tours indisponible ({reason}) — le signal d’allure a été utilisé à la place.",
  "note.lapsNotUsed": "Tours non utilisés : {reason}",
  "note.elevationHint":
    "Ce parcours présente un dénivelé important. Pour des répétitions de côtes, passez le « Type d’allure » sur « Ajustée à la pente ».",
  "lap.few": "Le fichier compte moins de 3 tours.",
  "lap.auto": "Les tours sont des temps de passage automatiques (chaque km / durée fixe), pas des tours de fractionné.",
  "lap.noAlternation": "Les tours ne montrent pas d’alternance nette rapide/lent.",
  "lap.fewWork": "Moins de deux tours d’effort.",
  "lap.structured":
    "Les tours contiennent les intensités de la séance (échauffement / actif / récupération / retour au calme) enregistrées par la montre.",
  "lap.manual": "Les tours ont été déclenchés par l’athlète (bouton tour) et classés selon l’allure.",
  "sig.reason": "Les intervalles ont été trouvés à partir du signal d’allure (détection de ruptures).",
  "sig.short": "Activité trop courte pour être analysée.",
  "sig.steady": "Aucune variation d’allure : l’activité ressemble à un effort régulier.",
  "sig.lowContrast":
    "L’allure varie trop peu pour distinguer efforts intenses et efforts faciles. Essayez une sensibilité plus élevée.",
  "sig.noWork": "Aucun effort intense au-dessus du seuil n’a été trouvé.",
  "sig.oneEffort":
    "Un seul effort intense trouvé : cela ressemble à un bloc tempo / contre-la-montre plutôt qu’à du fractionné.",

  // ---- segment kinds ---------------------------------------------------------------
  "kind.warmup": "Échauffement",
  "kind.work": "Effort",
  "kind.rest": "Récupération",
  "kind.cooldown": "Retour au calme",
  "kind.other": "Autre",

  // ---- toolbar -----------------------------------------------------------------------
  "tb.aria": "Réglages de la détection",
  "tb.source": "Source",
  "tb.auto": "Auto",
  "tb.laps": "Tours",
  "tb.signal": "Signal d’allure",
  "tb.paceType": "Type d’allure",
  "tb.pace": "Allure",
  "tb.speed": "Vitesse",
  "tb.gap": "Ajustée à la pente",
  "tb.sensitivity": "Sensibilité",
  "tb.minRep": "Effort min. (s)",
  "tb.minRest": "Récup. min. (s)",
  "tb.threshold": "Seuil effort/récup. ({unit})",
  "tb.snap": "Caler les tours sur l’allure",
  "tb.snapTitle":
    "Déplace les limites des tours que vous avez déclenchés à la main vers le changement d’allure réel le plus proche. Les tours d’une séance programmée ne sont jamais déplacés.",
  "tb.units": "Unités",
  "tb.km": "km",
  "tb.mi": "mi",
  "tb.autoThreshold": "auto",

  // ---- results ------------------------------------------------------------------------
  "res.fromLaps": "Détecté à partir des tours de l’appareil. {reason}",
  "res.fromSignal": "Détecté à partir du signal d’allure. {reason}",
  "res.gapNote":
    "Efforts et récupérations ont été jugés sur l’allure ajustée à la pente (effort équivalent à plat), pas sur l’allure brute.",
  "res.edited": "Modifié manuellement.",
  "hero.kicker": "Séance détectée",
  "hero.sub": "{count} efforts · {dist} de course intense en {time}",
  "hero.none": "Aucun intervalle détecté",
  "hero.noneHelp":
    "L’allure n’a jamais alterné entre efforts intenses et efforts faciles. Essayez d’augmenter la sensibilité ou de réduire la durée minimale d’un effort.",
  "struct.rest": "récup",

  // ---- tiles ----------------------------------------------------------------------------
  "tile.avgPace": "Allure moyenne des efforts",
  "tile.avgSpeed": "Vitesse moyenne des efforts",
  "tile.fastSlow": "Plus rapide {fast} · plus lent {slow}",
  "tile.varPace": "Variabilité de l’allure",
  "tile.varSpeed": "Variabilité de la vitesse",
  "tile.spread": "{spread} s/km entre le plus rapide et le plus lent",
  "tile.spreadMain": "{spread} s/km entre le plus rapide et le plus lent (série principale de {n})",
  "tile.trend": "Première → dernière rép.",
  "tile.faster": "{pct} plus rapide",
  "tile.slower": "{pct} plus lent",
  "tile.trendNote": "Tendance {v} s/km par rép.",
  "tile.rest": "Récupération type",
  "tile.ratio": "Effort : récup. = {v} : 1",
  "tile.hr": "Fréquence cardiaque en effort",
  "tile.hrUnit": "bpm moy.",
  "tile.hrNote": "Pic {peak}",
  "tile.hrNoteDrift": "Pic {peak} · dérive {drift} bpm",
  "tile.hrRec": "Récupération cardiaque par récup.",
  "tile.hrRecNote": "Fin d’effort → fin de récup.",

  // ---- timeline ---------------------------------------------------------------------------
  "tl.title": "Chronologie",
  "tl.recordedPace": "Allure enregistrée",
  "tl.recordedSpeed": "Vitesse enregistrée",
  "tl.avg": "Moyenne par intervalle",
  "tl.work": "Effort",
  "tl.time": "Temps",
  "tl.distance": "Distance",
  "tl.resetZoom": "Réinitialiser le zoom",
  "tl.hint":
    "Cliquez sur un bloc ou une ligne pour l’inspecter · faites glisser les poignées de la bande pour déplacer une limite · glissez sur le graphique pour zoomer, double-clic pour réinitialiser · les flèches parcourent les données.",
  "insp.rep": "Rép. {n}",
  "insp.typeAria": "Type de segment",
  "insp.mergePrev": "Fusionner ← préc.",
  "insp.mergeNext": "Fusionner suiv. →",
  "insp.split": "Couper en deux",
  "insp.reset": "Annuler les modifications",

  // ---- chart --------------------------------------------------------------------------------
  "ch.aria":
    "Chronologie des intervalles. Utilisez les flèches gauche et droite pour inspecter les valeurs, Entrée pour sélectionner l’intervalle sous le curseur.",
  "ch.summary":
    "{label} : chronologie avec {count} efforts détectés : {structure}. Les valeurs complètes figurent dans le tableau ci-dessous.",
  "ch.summaryNone": "{label} : chronologie. Aucun intervalle détecté.",
  "ch.hr": "Fréquence cardiaque (bpm)",
  "ch.ele": "Altitude ({unit})",
  "ch.threshold": "seuil effort/récup. {v}",
  "ch.drag": "Faites glisser pour déplacer cette limite",
  "tt.rep": "Rép. {n} · Effort",
  "tt.hr": "Fréq. cardiaque",
  "tt.ele": "Altitude",
  "tt.cad": "Cadence",
  "tt.grade": "Pente",
  "unit.spm": "ppm",
  "unit.bpm": "bpm",

  // ---- table -----------------------------------------------------------------------------------
  "tbl.title": "Intervalles",
  "tbl.all": "Tous les segments",
  "tbl.repsOnly": "Efforts seuls",
  "tbl.csv": "Télécharger le CSV",
  "tbl.caption": "Segments détectés avec allure, distance et fréquence cardiaque",
  "tbl.sumReps.one": "{n} effort",
  "tbl.sumReps.other": "{n} efforts",
  "col.type": "Type",
  "col.start": "Début",
  "col.time": "Durée",
  "col.dist": "Distance ({unit})",
  "col.pace": "{label} ({unit})",
  "col.gap": "GAP ({unit})",
  "col.gap.title": "Allure ajustée à la pente : ce que vaut l’effort à plat",
  "col.best": "Meilleurs 5 s",
  "col.best.title": "Les 5 secondes les plus rapides de l’effort",
  "col.hr": "FC moy.",
  "col.hrmax": "FC max",
  "col.hrend": "FC fin",
  "col.hrend.title": "Fréquence cardiaque moyenne sur les 5 dernières secondes",
  "col.cad": "Cadence",
  "col.pwr": "Puissance",
  "col.elev": "Dén. ↑/↓ {unit}",
  "col.fade": "Dérive %",
  "col.fade.title": "Positif = ralenti en seconde moitié, négatif = accéléré",
  "col.target": "Cible ({unit})",
  "tag.edited": "modifié",
  "tag.snapped": "calé",
  "tag.snappedTitle": "Limite du tour déplacée de {v} s",

  // ---- speed display ---------------------------------------------------------------------------
  "sd.pace": "Allure",
  "sd.speed": "Vitesse",
};
