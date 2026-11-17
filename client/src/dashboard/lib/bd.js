// Bangladesh districts (64) and Dhaka city thanas, for the order form's address fields.
export const DISTRICTS = ['Dhaka', 'Gazipur', 'Narayanganj', 'Narsingdi', 'Munshiganj', 'Manikganj', 'Tangail', 'Kishoreganj', 'Faridpur', 'Gopalganj', 'Madaripur', 'Rajbari', 'Shariatpur',
  'Chattogram', "Cox's Bazar", 'Cumilla', 'Feni', 'Noakhali', 'Lakshmipur', 'Chandpur', 'Brahmanbaria', 'Rangamati', 'Khagrachhari', 'Bandarban',
  'Rajshahi', 'Bogura', 'Pabna', 'Sirajganj', 'Naogaon', 'Natore', 'Chapainawabganj', 'Joypurhat',
  'Khulna', 'Jashore', 'Satkhira', 'Bagerhat', 'Kushtia', 'Jhenaidah', 'Magura', 'Narail', 'Chuadanga', 'Meherpur',
  'Barishal', 'Patuakhali', 'Bhola', 'Pirojpur', 'Barguna', 'Jhalokati',
  'Sylhet', 'Moulvibazar', 'Habiganj', 'Sunamganj',
  'Rangpur', 'Dinajpur', 'Kurigram', 'Gaibandha', 'Nilphamari', 'Lalmonirhat', 'Thakurgaon', 'Panchagarh',
  'Mymensingh', 'Jamalpur', 'Netrokona', 'Sherpur'];

export const DHAKA_THANAS = ['Adabor', 'Badda', 'Banani', 'Bangshal', 'Cantonment', 'Chawkbazar', 'Dakshinkhan', 'Darus Salam', 'Demra', 'Dhanmondi', 'Gendaria', 'Gulshan',
  'Hazaribagh', 'Jatrabari', 'Kadamtali', 'Kafrul', 'Kalabagan', 'Kamrangirchar', 'Khilgaon', 'Khilkhet', 'Kotwali', 'Lalbagh', 'Mirpur', 'Mohammadpur', 'Motijheel',
  'Mugda', 'New Market', 'Pallabi', 'Paltan', 'Ramna', 'Rampura', 'Sabujbagh', 'Shah Ali', 'Shahbagh', 'Sher-e-Bangla Nagar', 'Shyampur', 'Sutrapur', 'Tejgaon',
  'Turag', 'Uttara', 'Uttarkhan', 'Vatara', 'Wari', 'Bashundhara', 'Mohakhali'];

const SUBURBS = ['Savar', 'Ashulia', 'Keraniganj', 'Tongi', 'Narayanganj', 'Gazipur', 'Dhamrai', 'Nawabganj', 'Dohar'];

// Reads district, thana and zone out of an address written the way the customer wrote it.
export function splitAddress(text) {
  const s = String(text ?? '');
  const has = (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\']/g, '\\$&')}\\b`, 'i').test(s);
  const thana = DHAKA_THANAS.find(has) ?? '';
  const suburb = SUBURBS.find(has);
  const district = thana ? 'Dhaka' : DISTRICTS.find((d) => d !== 'Dhaka' && has(d)) ?? (has('Dhaka') || has('ঢাকা') ? 'Dhaka' : '');
  const zone = suburb ? 'dhaka_suburbs' : district === 'Dhaka' || thana ? 'inside_dhaka' : district ? 'outside_dhaka' : '';
  return { district: suburb && !thana ? (suburb === 'Narayanganj' || suburb === 'Gazipur' ? suburb : 'Dhaka') : district, thana: thana || suburb || '', zone };
}
