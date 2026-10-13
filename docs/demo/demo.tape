# The README's demo GIF (`just demo-gif`; needs `just infra-up` and vhs): an alert storm faster
# than one worker drains, shed with 503 + Retry-After and retried until every delivery is in, then
# the incidents it became. demo.sh starts and stops the stack off camera.
Output docs/demo/demo.gif

Require node
Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 16
Set Width 1300
Set Height 560
Set Padding 24
Set TypingSpeed 28ms
Set Framerate 12

Hide
Type "docs/demo/demo.sh down >/dev/null 2>&1; docs/demo/demo.sh up && clear"
Enter
Wait@120s
Show

Type "# One Tripwire worker turns about 600 alerts a second into incidents."
Enter
Sleep 400ms
Type "# A storm sends it 6,000 in a few seconds: watch the api shed and the sender retry."
Enter
Sleep 400ms
Type "node --env-file=.env docs/demo/storm.mjs 6000"
Enter
Wait@90s
Sleep 3s

Type "# Every delivery got in. What did 6,000 alerts become?"
Enter
Sleep 400ms
Type "docs/demo/demo.sh incidents"
Enter
Wait@90s
Sleep 7s

Hide
Type "docs/demo/demo.sh down"
Enter
Wait@90s
