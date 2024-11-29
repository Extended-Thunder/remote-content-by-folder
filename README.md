# "Remote Content By Folder" Thunderbird add-on

This Thunderbird add-on tells Thunderbird whether or not to allow or block the display of remote content in messages added to folders (usually, but not always, newly received messages) by matching regular expressions specified by the user against the names of the folders containing the messages.

The user can specify the regular expression whose matching folders allow remote content to display automatically and/or a separate regular expression whose matching folders block remote content automatically.

By default, the "allow" regexp is checked first, then the "block" regexp, and if neither matches, the add-on does nothing. There is a checkbox in the preferences which can be checked to reverse the order of the checks.

The user can also specify a regular expression matching folder names which
should be scanned for new messages on startup, most commonly "^Inbox$". This is
necessary because sometimes Thunderbird starts fetching new messages on startup
before it has initialized all add-ons, and Remote Content By Folder isn't told
by Thunderbird to check messages that were fetched before it was initialized.

You can support continued development and maintenance of this add-on via [Liberapay][Liberapay] or [Patreon][Patreon] for recurring donations or [Paypal][Paypal] or [Venmo][Venmo] for one-time donations.

[home page][github] | [addons.thunderbird.net][atn] | [bug reports][issues] |
[email support][email] | [recurring donation][subscribe] | [one-time
donation][donate]

## Detailed usage instructions

If an email message contains a link to remote images in it, then by default
Thunderbird blocks the remote images and displays a banner with a button you
can click to display the images and optionally add messages like this one to a
whitelist so images will be displayed automatically.

Alternatively, you can change your Thunderbird preferences so that remote
images are displayed by default, except in messages that Thunderbird thinks are
spam; remote images are blocked with the banner in those even if you enable the
preference to display remote images by default.

I wrote this add-on because I want slightly different behavior: I want
Thunderbird to decide whether to display or block the remote images in a
message based on what folder the message arrives in.

Here's are some examples configurations (configurations for the add-on are
added in its add-on preferences):

> ```
> Allow regexp: .*  
> Block regexp: ^(Spam|Trash|Deleted (Items|Messages))$  
> Regexp for folders to scan on startup: ^Inbox$  
> Check block regexp first: yes  
> ```

In [extended regular expressions][regexps], the kind used here, a period
matches any single character, "`*`" after anything means to match zero or more
copies of that thing, "`^`" matches the beginning of the string, "`$`" matches
the end of the string, and parentheses and vertical lines are used to group
alternatives. Therefore, what the configuration above says is, "Block remote
images for any messages that arrive in folders named Spam, Trash, Deleted
Items, or Deleted Messages, and display remote images for messages that arrive
in any other folder." Note that rather than using "`.*`" as the allow regexp, I
could just as well have used "`^`" by itself, which would mean, "Match any
string which has a beginning," which means any non-empty string (obviously
folder names are not empty).

Generally speaking, to list any arbitrary set of folder names in the "Allow
regexp" or "Block regexp" setting, do the following:

- Start with "`^`" to indicate the beginning of the string.
- Next put "`(`" to begin the list of folder names.
- List the folder names separated by "`|`", but put a backslash ("`\`") in front
  of any symbol in a folder name, to ensure that it isn't treated as a special
  regexp character.
- End with "`)$`" to mark the end of the list of folder names and the end of the
  string being matched..

Note that the settings you specify for Remote Content By Folder are only
applied when the message first arrives. If you change the settings Thunderbird
won't go back and re-evaluate whether to display images for existing messages,
and if you move or copy a message from one folder to another Thunderbird won't
re-evaluate whether to display images based on the target folder.

Similarly, this only impacts messages for which the question, "Should remote
images be displayed?" has never been answered before. So if Thunderbird decides
to block images in a message and puts up the banner, and then you tell it to
display the images in that message, that will stick even if the message is in a
folder that Remote Content By Folder thinks images should be blocked in.

## Copyright

Copyright 2024 Jonathan Kamens.

Copyright 2023 Extended Thunder Inc.

## License

This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/.

[regexps]: https://www.oreilly.com/ideas/an-introduction-to-regular-expressions
[github]: https://github.com/Extended-Thunder/remote-content-by-folder
[atn]: https://addons.thunderbird.net/thunderbird/addon/remote-content-by-folder/
[email]: mailto:jik+rcbf@extended-thunder.org
[issues]: https://github.com/Extended-Thunder/remote-content-by-folder/issues
[Liberapay]: https://liberapay.com/jik
[Patreon]: https://www.patreon.com/c/jikseclecticofferings
[Paypal]: https://paypal.me/JonathanKamens
[Venmo]: https://venmo.com/Jonathan-Kamens
