/** Dated Apple guidance only. This does not add a device, SKU, quote or purchase permission to the runtime catalog. */
export function macBookPro2019Guide(text: string, language: string) {
 const value=text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/,/g," ").replace(/\s+/g," ").trim().replace(/[.!?]$/,"");
 const model=value.replace(/^(?:i need a charger for|my laptop is|my model is|necesito un cargador para|mi portatil es|mi modelo es) (?:my |a |mi |un )?/,"");
 if(!/^(?:macbook pro 16(?:-inch| inch| pulgadas) 2019|macbookpro16 [14])$/.test(model))return null;
 const es=language === "es";
 return {
  name:"MacBook Pro (16-inch, 2019)", referenceCents:7900, checkedDate:"2026-10-27", checkoutAvailable:false,
  productUrl:"https://www.apple.com/shop/product/mw2l3am/a/96w-usb-c-power-adapter",
  supportUrl:"https://support.apple.com/en-us/109509",
  specificationUrl:"https://support.apple.com/en-us/111932",
  summary:es
   ? "Para el MacBook Pro de 16 pulgadas de 2019, Apple recomienda su adaptador USB-C de 96W y un cable de carga USB-C. El precio de referencia del adaptador es 79 dólares, consultado el 27 de octubre de 2026; el cable se vende por separado. ShopAccess todavía no ofrece la compra de este adaptador. Puede abrir el enlace del producto Apple en la página."
   : "For the 16-inch 2019 MacBook Pro, Apple recommends its 96W USB-C adapter and a USB-C charge cable. The adapter reference price is 79 dollars, checked October 27, 2026; the cable is sold separately. ShopAccess does not yet offer checkout for this adapter. You can open the Apple product link on this page.",
 };
}
