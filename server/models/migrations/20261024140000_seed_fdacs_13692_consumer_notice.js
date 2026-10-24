// FDACS-13692 Consumer Notice Form (Rev. 07/21), the state form Rule
// 5E-14.105(1), F.A.C. (as amended 4-29-2025) requires a licensee to have
// the property owner or authorized agent sign BEFORE entering a contract for
// wood-destroying organism treatment (owner 10-24 "do these": PR2).
//
// The text is the state's form, reproduced as published (flrules Ref-13400 /
// forms.fdacs.gov/13692.pdf, Commissioner Wilton Simpson copy): English page
// then the Spanish page, including the form's own spelling. Nothing is added
// inside the form. Filled fields: the company name, the consumer's printed
// name (the customer), the representative's printed name and date (staff at
// issue). The consumer's signature and date are the e-signature.
const TEMPLATE = {
  template_key: 'consumer_notice.fdacs_13692',
  name: 'FDACS-13692 Consumer Notice Form',
  category: 'compliance',
  document_type: 'consumer_notice',
  description: 'Florida Consumer Notice Form FDACS-13692 Rev. 07/21 (Rule 5E-14.105(1)): signed by the property owner or authorized agent before any wood-destroying organism contract.',
  tags: ['termite', 'consumer notice', 'FDACS-13692', 'compliance'],
  requires_signature: true,
  title: 'Consumer Notice Form (FDACS-13692)',
  body: [
    '**Florida Department of Agriculture and Consumer Services**',
    '**Division of Agricultural Environmental Services**',
    '**CONSUMER NOTICE FORM**',
    'Rule 5E-14.105, F.A.C.',
    '',
    'A pest control company must give you a written contract prior to any treatment of each wood-destroying organism. It is very important that you read and understand the contract you are signing. The pest control company is only obligated to follow the terms of the contract you have signed, regardless of other statements by the company or salesperson. (Note: Contracts for treatment for new construction can be issued to the builder and provided to you at closing).',
    '',
    '**BASIC REQUIREMENTS FOR CONTRACTS**',
    '- The contract must state the common name of the wood-destroying organism to be controlled by the company (e.g. subterranean termite, powder post beetle). If the contract is for termite control, the contract must clearly state whether Formosan termites are covered or not.',
    '- Some contracts do not include a treatment at the time the contract is issued, and that should be clearly stated. If a treatment is performed as part of the contract, the cost for the treatment must be stated. If the treatment is only for certain areas, the contract should clearly state that it is for “spot treatment” only.',
    '- The contract must state if it is a retreatment only or a retreatment and repair contract. If it is a retreatment and repair contract, carefully read the sections of the contract that state when repairs will or will not be covered by the contract.',
    '',
    '**REQUIREMENTS FOR STATING WHEN TREATMENT OR REPAIR WILL NOT BE COVERED BY THE CONTRACT**',
    '- Repair contracts will not cover repairs from termite damage under every condition. The contract must state when retreatment or repair will be done, and conditions under which the company can refuse to retreat or repair.',
    '- These conditions have to be stated and be under headings in the contract that are in bold print. Companies typically refuse repair or retreatment if the condition of the house is such that moisture or leaks result in termite infestation, or where siding makes it hard to see termite infestation',
    'Examples of this are:',
    '• Cracks in concrete slabs • Leaks in the roof • Wood or wall siding in contact with ground • Water accumulating against side of house • Plumbing leaks',
    'The law does require that companies notify you if they see conditions which would void the repair promise and they have to give you a chance to correct the condition before voiding the contract or denying repair coverage.',
    '- Contracts may have a condition that does not cover Formosan termite damage until a specific time period has passed. This means that if damage occurs during this period the company will not pay for repair.',
    '- You have the right to compare contracts from other companies before signing a contract with a company. Choose the company that gives you the best contract options.',
    '- If you have any questions about the terms of the contract, or concerns about the compliance history of the company with regard to pest control laws or regulations, contact the Department of Agriculture and Consumer Services at phone number: 850-617-7996 or email: biircomplaints@fdacs.gov.',
    '',
    'I understand that I am entering into a contract with Waves Pest Control, LLC (fill in company name) to provide wood-destroying organism(s) treatment, and I have read and understood the terms of the contract.',
    '',
    'Print Name of Consumer: {{customer.name}}',
    'Title: Property Owner or authorized agent',
    'Signature of Consumer and Date: the electronic signature below.',
    'Print Name of Pest Control Representative: {{issuer.name}} · Date: {{issuer.date}}',
    'Signature of Pest Control Representative: /s/ {{issuer.name}} (electronic signature for the company)',
    'Company: Waves Pest Control, LLC',
    '',
    'FDACS-13692 Rev. 07/21 · Page 1 of 2 · (La traducción española en la espalda)',
    'Bureau of Inspection and Incident Response, 850-617-7996',
    '',
    '**Florida Department of Agriculture and Consumer Services**',
    '**Division of Agricultural Environmental Services**',
    '**Formulario de Aviso al Consumidor**',
    'Rule 5E-14.105, F.A.C.',
    '',
    'Una compania de control de plagas debe proveerle con un contrato escrito antes de comenzar cualquier tratamiento para organismos destructores de madera. Es muy importante que usted lea y entienda el contrato que esta por firmar. La compania de control de plagas solo esta obligada a seguir los terminus del contrato que usted haya firmado, independientemente de cualquier otra explicacion o afirmacion hecha por el vendedor de la compania. (Nota: El Contrato para el tratamiento de nuevas construcciones pueden ser expedido al contratista y le sera entregado al cierre de la negociacion).',
    '',
    '**REQUERIMIENTOS BASICOS PARA CONTRATOS**',
    '- El contrato debe establecer el nombre comun del organisno destructor de madera a ser tratado por la compania (ej. Termitas subterraneas, escarabajo de la madera). Si el contrato es para el control de termitas, el mismo debe claramente establecer si la termite Formosan esta o no cubierta.',
    '- Algunos contratos no incluyen un tratamiento al momento de expedir el mismo y eso debe estar claramente establecido. Si un tratamiento es realizado como parte de un contrato, el costo por ese tratamiento debe ser especificado. Si el tratamiento es solo para algunas areas, esto tambien debe estar estipulado dentro del contrato como “Tratamiento Localizado” solamente.',
    '- El contrato debe establecer si solo cubre tratamientos o si cubre tratamientos y reparaciones. De ser un contrato para tratamientos y reparaciones, lea cuidadosamente las secciones del contrato que establecen que tipo de reparaciones seran o no cubiertas por el contrato.',
    '',
    '**REQUERIMIENTOS QUE ESTABLECEN CUANDO UN TRATAMIENTO O REPARACION NO SERA CUBIERTO POR EL CONTRATO.**',
    '- Los contratos de reparaciones no cubriran los danos ocasionados bajo distintas circunstancias por termitas. El contrato debe establecer cuando el tratamiento o reparacion sera realizado y las condiciones bajo las cuales la compania pudiera rechazar tartar la plaga o reparar el dano.',
    '- Esas condiciones deben ser establecidas y resaltadas como titulo en el contrato. Las companies tipicamente rehusan reparar danos or tratar plagas si la casa presenta condiciones de humedad o grietas que permiten la presencia de termitas a un nivel de infestacion, o cuando los revestimientos de paredes dificulte detectar la presencia de termitas.',
    'Ejemplos de esto es:',
    '• Grietas en losas de concreto • Goteras en el techo • Madera o revestimiento de paredes en contacto con el suelo. • Acumulacion de agua contra un costado de la casa. • Fugas de plomeria.',
    'La ley no requiere que las companies le notifiquen si ellos observan alguna(s) condicion(es) que pudiera anular la clausula de reparacion y deben darle una oportunidad para corregir cualquier anomalidad antes de anular el contrato o negar la cobertura de reparacion.',
    '- Los contratos pueden presenter una clausula donde los danos producidos por termitas Formosan no son cubiertos hasta un periodo de tiempo previamente establecido por el mismo. Esto significa que si el dano ocurre durante ese periodo de tiempo establecido la compania no pagara las reparaciones necesarias.',
    '- Usted tiene el derecho de comparar contratos de otras companias antes de firmar un contrato con una de ellas. Elija la compania que le provea las mejores opciones.',
    '- Si usted tiene alguna duda o pregunta acerca de los terminos del contrato o alguna duda o preocupacion acerca del record historico de trabajo de la compania con respecto a las leyes y regulaciones para el control de plagas, por favor contacte el Departamento de Agricultura y Servicios al Consumidor al numero telefonico: 850-617-7996 o escribanos al email:biircomplaints@fdacs.gov.',
    '',
    'Entiendo que estoy aceptando el contrato establecido por Waves Pest Control, LLC (coloque el nombre de la compania) para el tratamiento de organismo(s) destructor de madera, y he leido y entendido los terminos del mismo.',
    '',
    'Imprima el Nombre de Consumidor: {{customer.name}}',
    'El título: El Dueño de la propiedad o autorizó a agente',
    'La firma de Consumidor y la fecha: la firma electrónica abajo.',
    'Imprima el Nombre de Representante de Control de Peste: {{issuer.name}} · La fecha: {{issuer.date}}',
    'La firma de Representante de Control de Peste: /s/ {{issuer.name}} (firma electrónica por la compañía)',
    'La compañía: Waves Pest Control, LLC',
    '',
    'FDACS-13692 Rev. 07/21 · Page 2 of 2 · (El inglés en la frente)',
    'Bureau of Inspection and Incident Response, 850-617-7996',
  ].join('\n'),
  variables: ['customer.name', 'issuer.name', 'issuer.date'],
};

exports.up = async function up(knex) {
  // A reused row keeps nothing stale: this key is reserved for the state form.
  let template = await knex('document_templates').where({ template_key: TEMPLATE.template_key }).forUpdate().first();
  const fields = {
    name: TEMPLATE.name,
    category: TEMPLATE.category,
    document_type: TEMPLATE.document_type,
    status: 'active',
    audience: 'customer',
    description: TEMPLATE.description,
    requires_signature: TEMPLATE.requires_signature,
    variables: JSON.stringify(TEMPLATE.variables),
    tags: JSON.stringify(TEMPLATE.tags),
  };
  if (template) {
    await knex('document_templates').where({ id: template.id }).update({ ...fields, updated_at: knex.fn.now() });
  } else {
    [template] = await knex('document_templates').insert({ template_key: TEMPLATE.template_key, ...fields }).returning('*');
  }
  // This migration's version is found by its body, numbered after any other.
  let version = await knex('document_template_versions').where({ template_id: template.id, body: TEMPLATE.body }).first();
  if (!version) {
    const latest = await knex('document_template_versions').where({ template_id: template.id }).max('version_number as n').first();
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: (Number(latest?.n) || 0) + 1,
      title: TEMPLATE.title,
      body: TEMPLATE.body,
      signer_disclosure: 'I agree to receive and sign this document electronically.',
      variables: JSON.stringify(TEMPLATE.variables),
      required_fields: JSON.stringify(['initials', 'signedName']),
      published_at: knex.fn.now(),
    }).returning('*');
  }
  await knex('document_templates').where({ id: template.id }).update({ active_version_id: version.id, updated_at: knex.fn.now() });
};

// Undo only this migration's version, and only while nothing was signed from
// it: a signed consumer notice is a compliance record and keeps its text.
exports.down = async function down(knex) {
  const template = await knex('document_templates').where({ template_key: TEMPLATE.template_key }).forUpdate().first();
  if (!template) return;
  const mine = await knex('document_template_versions').where({ template_id: template.id, body: TEMPLATE.body }).first();
  if (!mine) return;
  const issued = await knex('customer_contracts').where({ document_template_version_id: mine.id }).first();
  if (issued) return;
  await knex('document_templates').where({ id: template.id, active_version_id: mine.id }).update({ active_version_id: null });
  await knex('document_template_versions').where({ id: mine.id }).del();
};

exports.TEMPLATE = TEMPLATE;
