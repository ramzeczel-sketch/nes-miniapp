# Лицензии и авторство / Licenses & credits

В репозиторий включены **только** ROM-ы, авторы которых явно разрешили
свободное распространение (open source / permissive). Никаких коммерческих игр.
Only freely redistributable homebrew is bundled. No commercial ROMs.

| Игра | Автор | Лицензия | Источник (исходники и релиз) | Файл лицензии |
|---|---|---|---|---|
| 8-Bit Table Tennis v1.0 | Michael Billington | MIT | https://github.com/mike42/8bit-table-tennis (release v1.0, `table_tennis_v1.0.nes`) | `8bit-table-tennis-MIT.txt` |
| Double Action Blaster Guys v2 | NovaSquirrel | zlib | https://github.com/NovaSquirrel/DABG (release v2, `dabg.nes`) | `dabg-zlib.txt` |
| Thwaite v0.04 | Damian Yerrick | GPL-3.0-or-later (часть исходников — zlib-подобная) | https://github.com/pinobatch/thwaite-nes (release v0.04, `thwaite.nes`); исходный код ROM — тот же репозиторий, тег v0.04 | `thwaite-GPL-3.0.txt` |
| RHDE: Furniture Fight v0.07 | Damian Yerrick (концепт: NovaSquirrel, Sean Sells; музыка: The Eighth Bit и аноним) | GNU All-Permissive License | https://github.com/pinobatch/rhde-nes (release v0.07, `rhde.nes`) | `rhde-all-permissive.txt` |

Файлы ROM не изменялись (бинарники из официальных релизов GitHub).
Thwaite — копилефт (GPL-3.0+): при распространении вместе с ROM нужно предоставлять
исходный код — он доступен по ссылке выше (тег v0.04).

## Программные компоненты
* **JSNES** 2.1.0 — эмулятор NES на JavaScript, Apache-2.0
  (https://github.com/bfirsh/jsnes, `LICENSES/jsnes-APACHE-2.0.txt`). Файл `public/vendor/jsnes.min.js` — неизменённая сборка из npm.
* express (MIT), ws (MIT).

## SHA-256 ROM-ов
Вычисляются сервером при запуске и отдаются в `/api/games`.
eca79b9d0b546e96c1bc73099e239539fb9c7773ff10a431bb3a9cd6763208ca  roms/double-action-blaster-guys.nes
b2c4748a5b3651e393572046daf126213653b58b55472cdfdf4b863834dd0241  roms/rhde-furniture-fight.nes
05122457672f95fcf2ee518c3f37e506617725c2d031100b1b1c8b7785068ea3  roms/table-tennis.nes
a2df24d9c9f72e56c2fdc4c703becc47a5700ad0158da8208247635ebeb3779c  roms/thwaite.nes
