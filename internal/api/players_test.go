package api

import (
	"reflect"
	"testing"
)

func TestParsePlayers(t *testing.T) {
	cases := []struct {
		reply  string
		online int
		max    int
		names  []string
	}{
		{"There are 0 of a max of 20 players online:", 0, 20, []string{}},
		{"There are 2 of a max of 20 players online: Sn0wyee, Alice", 2, 20, []string{"Sn0wyee", "Alice"}},
		// A mod reworded the line: report no numbers rather than a wrong count.
		{"Online players (1/8)", -1, -1, []string{}},
		{"", -1, -1, []string{}},
	}
	for _, c := range cases {
		online, max, names := parsePlayers(c.reply)
		if online != c.online || max != c.max {
			t.Errorf("%q gave %d/%d, want %d/%d", c.reply, online, max, c.online, c.max)
		}
		if !reflect.DeepEqual(names, c.names) {
			t.Errorf("%q gave names %q, want %q", c.reply, names, c.names)
		}
	}
}
