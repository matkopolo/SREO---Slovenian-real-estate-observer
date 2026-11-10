package httpapi

import "net/http"

var demographySources = []map[string]string{
	{"table": "SURS 05C4004S", "name": "Prebivalstvo po starostnih skupinah in občinah (1. januar)"},
	{"table": "SURS 05L2016S", "name": "Umrli po starostnih skupinah in statističnih regijah"},
	{"table": "SURS 05I2002S", "name": "Selitveno gibanje prebivalstva po občinah"},
	{"table": "SURS 0861110S", "name": "Stanovanja po naseljenosti (registrski popis)"},
	{"table": "SURS 0861102S", "name": "Naseljena stanovanja po tipu lastništva (registrski popis)"},
	{"table": "SURS 05F3015S", "name": "Gospodinjstva po številu članov (registrski popis)"},
	{"table": "SURS 05E3002S", "name": "Prebivalstvo po gospodinjskem statusu in starosti, Slovenija"},
}

// releasesCaveatCode names the caveat for clients that translate it; releasesCaveat is its
// Slovenian text.
const releasesCaveatCode = "model_estimate_older_owners"

const releasesCaveat = "Modelna ocena: starejši (65+), ki živijo sami × starostna stopnja umrljivosti × delež lastniških stanovanj. " +
	"Ni napoved ponudbe ali cen: dedovanje traja, stanovanja pogosto ostanejo v družini, lokacija in velikost se ne ujemata s povpraševanjem."

func (s *server) demographics(w http.ResponseWriter, r *http.Request) {
	geographyID, ok := optionalGeographyID(w, r)
	if !ok {
		return
	}
	profile, err := s.demography.Profile(r.Context(), geographyID)
	if err != nil {
		s.fail(w, r, "load demographics", err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"profile": profile, "sources": demographySources,
		"licence": "Vir: SURS (prosta uporaba z navedbo vira)", "releasesCaveat": releasesCaveat, "releasesCaveatCode": releasesCaveatCode})
}

func (s *server) demographicsMunicipalities(w http.ResponseWriter, r *http.Request) {
	items, err := s.demography.Municipalities(r.Context())
	if err != nil {
		s.fail(w, r, "load municipal demographics", err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"items": items, "sources": demographySources, "releasesCaveat": releasesCaveat, "releasesCaveatCode": releasesCaveatCode})
}
