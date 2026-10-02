/* Print Wallah doodle icons. Hand-drawn feel: round caps, slightly uneven lines, one soft accent shape.
   Colours come from CSS (--doodle-a accent blob, --doodle-b second accent, currentColor for the line). */
(function () {
  const A = 'fill="var(--doodle-a)"', B = 'fill="var(--doodle-b)"';
  const face = (x, y) => `<circle cx="${x}" cy="${y}" r="1.4" fill="currentColor" stroke="none"/><circle cx="${x + 9}" cy="${y}" r="1.4" fill="currentColor" stroke="none"/><path d="M${x + 2.5} ${y + 5.5}q2.2 2.2 4.4 0"/>`;
  const SHAPES = {
    upload: `<path ${A} stroke="none" d="M10 46c-3-12 4-27 17-30 14-3 28 4 27 18-1 13-12 18-24 17-10 0-17-1-20-5z"/><path d="M20 22.5l1.2 26.5c0 1.8 1.2 3 3 3l17.4-.4c1.7 0 3-1.200 3-3l1.2-17.700-8.600-9.200z"/><path d="M34.200 22.200l.6 8.600 8.400.2"/><path d="M32.500 45.500V35m0 0l-4.200 4.300m4.200-4.300l4.500 4.200"/><path d="M50 12v6m-3-3h6" stroke-width="2"/>`,
    doc: `<path ${A} stroke="none" d="M14 20c1-6 6-8 12-8l18 1c4 .5 6 3 6 8l-1 22c0 5-3 8-8 8l-16 .4c-6 0-9-3-10-8z"/><path d="M19 10.500l22.500.4 8.300 8.600-.8 28.400c0 2.200-1.500 3.700-3.700 3.700l-25.600.2c-2 0-3.500-1.500-3.500-3.500z"/><path d="M41.500 11l.4 9 8 .2"/><path d="M24 29h16m-16 6h20m-20 6h12"/>`,
    printer: `<path ${A} stroke="none" d="M8 30c0-5 3-8 8-8l32 .5c5 0 8 3 8 8l-.5 14c0 3-2 5-5 5H13c-3 0-5-2-5-5z"/><path d="M19 22V10.500c0-1.400 1-2.400 2.400-2.400l21.200.2c1.400 0 2.400 1 2.400 2.400V22"/><path d="M14.500 22h35c4 0 6.500 2.500 6.500 6.500v14.500c0 3-2 5-5 5h-6m-37 0c-3 0-5-2-5-5V28.500C8.500 24.500 11 22 14.500 22"/><path d="M19.500 36.500h25l.8 15.200c0 1.200-.8 2-2 2l-22 .2c-1.200 0-2-.8-2-2z" ${B}/><path d="M24 43h16m-16 5h10"/><circle cx="50" cy="29" r="1.600" fill="currentColor" stroke="none"/>`,
    pay: `<path ${A} stroke="none" d="M16 14c1-4 4-6 8-6h16c4 0 7 2 8 6l3 36c0 4-3 6-7 6H22c-4 0-7-2-7-6z"/><rect x="16" y="7" width="32" height="50" rx="6.500"/><path d="M28 12.500h8"/><circle cx="32" cy="34" r="10.500" ${B}/><path d="M27.500 29.500h9m-9 4h9m-9.500 0c5 0 7 0 7.500 4.500l-6 4.500" stroke-width="2.200"/><circle cx="32" cy="51.500" r="1.400" fill="currentColor" stroke="none"/>`,
    photo: `<path ${A} stroke="none" d="M8 22c0-6 3-9 9-9l31 .6c6 0 9 3 9 9l-.6 22c0 5-3 8-8 8l-33 .4c-5 0-8-3-8-8z"/><rect x="9" y="14" width="46" height="38" rx="6"/><circle cx="23" cy="26" r="4.500" ${B}/><path d="M10.500 46l13-11 8 7 8-9 13.500 13"/>`,
    sliders: `<path ${A} stroke="none" d="M8 18c0-5 3-8 8-8h32c5 0 8 3 8 8v26c0 5-3 8-8 8H16c-5 0-8-3-8-8z"/><path d="M16 21h32M16 32h32M16 43h32"/><circle cx="26" cy="21" r="4.200" ${B}/><circle cx="40" cy="32" r="4.200" ${B}/><circle cx="23" cy="43" r="4.200" ${B}/>`,
    success: `<path ${A} stroke="none" d="M7 31c-1-15 10-25 24-24 15 1 26 11 25 26-1 14-12 24-26 23C15 55 8 45 7 31z"/><path d="M19.500 33l8.500 8.500L45 22.500" stroke-width="4"/><path d="M52 8v6m-3-3h6M10 50l.1 5m-2.500-2.500h5" stroke-width="2"/>`,
    wait: `<path ${A} stroke="none" d="M12 20c1-6 6-10 12-10h16c6 0 11 4 12 10l2 24c0 6-5 10-11 10H21c-6 0-11-4-11-10z"/><path d="M20 9h24M20 55h24M22 9c0 11 8 14 10 23-2 9-10 12-10 23m20-46c0 11-8 14-10 23 2 9 10 12 10 23"/><path d="M26 47c3-4 9-4 12 0z" ${B}/>`,
    empty: `<path ${A} stroke="none" d="M10 20c1-6 6-9 12-9h22c6 0 11 3 12 9l1 24c0 6-5 9-11 9H20c-6 0-11-3-11-9z"/><path d="M17 10h30c3 0 5 2 5 5v34c0 3-2 5-5 5H17c-3 0-5-2-5-5V15c0-3 2-5 5-5z"/>${face(24, 28)}<path d="M20 44h24" stroke-dasharray="1 5" stroke-width="2.500"/>`,
    info: `<path ${A} stroke="none" d="M8 30c0-12 9-21 22-21 13 0 24 8 24 21 0 12-9 21-22 21H15l-6 6z"/><path d="M12 28c0-10 8-17 19-17s20 7 20 17-8 18-19 18H17l-6 7z"/><path d="M31 25v10"/><circle cx="31" cy="19.500" r="1.500" fill="currentColor" stroke="none"/>`,
    rupee: `<circle cx="32" cy="32" r="22" ${A} stroke="none"/><circle cx="32" cy="32" r="20"/><path d="M23.500 22.500h17m-17 6h17m-17.500 0c8 0 11 1 11.500 8l-9.500 9.500"/>`,
    wave: `<path d="M8 36c4-6 8-6 12 0s8 6 12 0 8-6 12 0 8 6 12 0" stroke-width="3"/>`,
    pin: `<path d="M32 56s-15-14-15-26a15 15 0 0130 0c0 12-15 26-15 26z"/><circle cx="32" cy="30" r="5" ${B}/>`,
    phone: `<path d="M16 12c0-2 1-3 3-3h6l4 11-5 3c3 6 7 10 13 13l3-5 11 4v6c0 2-1 3-3 3C27 44 14 31 13 15z" ${A}/>`,
    store: `<path d="M10 20h44c2 0 4 2 4 4v30c0 2-2 4-4 4H10c-2 0-4-2-4-4V24c0-2 2-4 4-4zm2 4v28h40V24H12z" ${A}/>`,
  };
  window.icon = (name, size = 28, extra = '') => `<svg class="doodle ${extra}" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${SHAPES[name] || ''}</svg>`;
})();
