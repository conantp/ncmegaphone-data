// Get House and Senate Emails
var request = require('request');
var cheerio = require('cheerio');
const fs = require('fs');

function getLegislatorEmails(name, url) {
	var output_data = [];
	request(url, function (error, response, html) {
	  if (!error && response.statusCode == 200) {
	  	console.log('success loading', url);

		var $ = cheerio.load(html);
	    $('#contactTable tbody tr td:nth-child(5) a').each(function(i, element) {
	    	output_data.push($(this).text() );
	    });

	    output_data = output_data.sort(
	    	function(a, b) {
			  var last_name_cmp = a.substr(a.indexOf('.') + 1).toLowerCase().localeCompare(b.substr(b.indexOf('.') + 1).toLowerCase() );

			  if (last_name_cmp != 0) {
			  	return last_name_cmp;
			  } else {
			  	return a.localeCompare(b);
			  }
			}
		);

	    console.log("For " + name + ", found: " + output_data.length);

	    fs.writeFile("output/" + name + ".txt", JSON.stringify(output_data), function(err) {
			if (err) {
			    return console.log(err);
			}

			console.log("The file was saved: ", name);
		}); 
	  } else {
	  	console.log('error on loading: ' + url, error);
	  }
	});
}

getLegislatorEmails('house', 'https://www.ncleg.gov/Members/ContactInfo/H');
getLegislatorEmails('senate', 'https://www.ncleg.gov/Members/ContactInfo/S');
