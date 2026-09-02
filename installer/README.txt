SUNBURST DISK — macOS INSTALLATION

Important: remove the quarantine attribute from the downloaded DMG before opening it.

1. Download the Sunburst Disk DMG, but do not open it yet.
2. Open Terminal and run this command. Replace the filename if your downloaded version is different:

   xattr -d com.apple.quarantine "$HOME/Downloads/Sunburst Disk-0.2.7-arm64.dmg"

   If the DMG was saved somewhere else, replace the path with the actual path to the downloaded DMG.
3. Open the DMG and drag Sunburst Disk.app to the Applications folder.
4. Eject the DMG from Finder after the application has been copied. The DMG is only an installer disk image and should not be kept mounted for normal use.
5. Launch Sunburst Disk from Applications. If macOS asks for confirmation, choose Open.

The xattr command removes only the quarantine flag from this downloaded installer image. It does not grant Full Disk Access, administrator rights, or permission to delete files. Sunburst Disk continues to use confirmation-first file operations and keeps protected system locations blocked.

For a newly downloaded ad-hoc build, repeat the xattr command for that specific DMG before opening it. Do not run the command against random files or applications.

Sunburst Disk — macOS arm64
https://github.com/desillusionist/sunburst-disk

End of README

