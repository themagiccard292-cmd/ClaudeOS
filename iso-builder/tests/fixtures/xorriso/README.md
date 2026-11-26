# xorriso report samples

Output of `xorriso -indev ISO -report_el_torito plain -report_system_area plain` (xorriso 1.5.6, Ubuntu 24.04).

* `report-bios-efi.txt` - captured from a synthetic image laid out like the Ubuntu 26.04 desktop ISO
  (GRUB El Torito BIOS image + UEFI image in an appended GPT EFI System Partition, grub2 MBR).
* the other files are derived from it by removing lines, modelling broken or legacy layouts:
  `report-bios-only.txt` (no EFI at all), `report-efi-only.txt` (no BIOS El Torito image),
  `report-no-boot.txt` (no boot records), `report-bios-mbr-esp.txt` (BIOS + ESP announced only as MBR type 0xef).
