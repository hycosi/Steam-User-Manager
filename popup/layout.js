// Set the document mode before CSS participates in extension popup auto-sizing.
'use strict';
document.documentElement.classList.toggle('tab-mode', new URLSearchParams(location.search).has('tab'));
