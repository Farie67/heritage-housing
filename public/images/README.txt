HERITAGE HOUSING PROJECTS — IMAGES FOLDER
=========================================

Everything the website needs is in this folder. There are no external image
URLs and no Base64 strings anywhere in the site.

The files present now are PLACEHOLDERS. They are deliberately labelled
"Photograph to follow" rather than filled with stock photography of foreign
houses, because a stock photo presented as a Gweru development is a misleading
advert. Replace each one with a real photograph, keeping the same filename.


WHAT TO UPLOAD
--------------
Upload this whole folder to the web root on cPanel, keeping the name `images`.
The site references them as `/images/<name>.jpg`, so the folder must sit at the
top level of the domain.

Replace these 14 files, keeping the exact filenames:

  DEVELOPMENT PHOTOGRAPHS             Recommended size   Used for
  ---------------------------------------------------------------------------
  heritage-park.jpg                   1600 x 1000        Heritage Park card
  raylands-estate.jpg                 1600 x 1000        Raylands Estate card
  goshen-park.jpg                     1600 x 1000        Goshen Park card
  mkoba-21.jpg                        1600 x 1000        Mkoba 21 card
  emganini.jpg                        1600 x 1000        Emganini card
  gorge-of-toronto.jpg                1600 x 1000        Gorge of Toronto card

  INDIVIDUAL PROPERTY PHOTOGRAPHS     Recommended size   Used for
  ---------------------------------------------------------------------------
  stand-hp-0245.jpg                   1200 x 900         Stand HP-0245
  stand-gp-0102.jpg                   1200 x 900         Stand GP-0102
  stand-em-0245.jpg                   1200 x 900         Stand EM-0245

  PAGE IMAGES                         Recommended size   Used for
  ---------------------------------------------------------------------------
  hero-home.jpg                       1800 x 1000        Home page banner
  featured-development.jpg            1200 x 900         Home page feature block

  SERVICES PAGE PHOTOGRAPHS           Recommended size   Used for
  ---------------------------------------------------------------------------
  service-land-property-development.jpg   1200 x 800     Land & Property Development
  service-civil-infrastructure-works.jpg  1200 x 800     Civil & Infrastructure Works
  service-construction-property.jpg       1200 x 800     Construction & Property

On the Services page each photograph sits above the service's heading and
bullet list, filling the top of the card. Landscape works best; the image is
cropped to fit, so keep the subject near the middle.

The three service paths are editable in Admin -> Content -> Services, under
"Photograph (path under /images/)". Rename a service and its image does not
follow automatically — update the path there too.

Landscape photographs work best. They are displayed cropped to fill, so keep
the subject near the middle.


ADDING A NEW DEVELOPMENT OR PROPERTY
------------------------------------
The admin does not upload files. It takes a URL or path, so after uploading a
new photograph:

  1. Save it here as, for example, `newtown.jpg`
  2. Admin -> Projects -> open the development -> Photograph URL: /images/newtown.jpg
     (or Admin -> Properties -> open the property -> Photograph URL)


IF AN IMAGE IS MISSING
----------------------
Nothing breaks. Every image sits on a coloured background, so a missing file
shows the brand navy rather than a broken-image icon. The text stays readable.


THE LOGOS
---------
The logo files are NOT in this folder — they are already local and are used
directly by the site:

  assets/img/logo.png         152 KB   light backgrounds (header)
  assets/img/logo-light.png   116 KB   dark backgrounds (footer)
  assets/img/logo-mark.png     76 KB   square mark
  assets/img/favicon-64.png     6 KB   browser tab

Leave those where they are; they are referenced by the stylesheet and the
branding settings.
