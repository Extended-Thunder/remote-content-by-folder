FILES := LICENSE README.md bootstrap.js chrome.manifest \
         content/defaultPreferencesLoader.jsm content/options.xul \
         content/prefs.js install.rdf

all: remote-content-by-folder.xpi

remote-content-by-folder.xpi: $(FILES)
	-rm -f $@.tmp
	zip -r $@.tmp $^
	mv -f $@.tmp $@

clean:
	-rm -f *.tmp *.xpi
